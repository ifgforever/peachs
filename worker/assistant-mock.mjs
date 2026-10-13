#!/usr/bin/env node
// Rome's Joy admin: a stand-in for Claude's Messages API, so the Assistant can be tested without a real key.
//   node worker/assistant-mock.mjs [--port 8932] [--log <file>]
// Run wrangler dev with ANTHROPIC_API_KEY=test and ANTHROPIC_BASE_URL=http://127.0.0.1:8932, then script replies:
//   POST /__mock/script  body: one reply or a list of replies, appended to the queue
//   POST /__mock/reset   empties the queue (the log file is kept; tests read it by line)
// A reply is { content: [blocks], stop_reason?, stop_details?, usage?, times? } where a block is
//   { type: 'thinking' } | { type: 'text', text } | { type: 'tool_use', name, input } | { type: 'fallback', to? }
// (a fallback block marks where a refusal fallback took over mid-reply, as the API streams it; the message model
// becomes `to`, default claude-opus-5)
// (stop_reason defaults to tool_use when there is a tool call, else end_turn; `times` repeats the reply), or
// { status, error: { type, message } } for an HTTP error. With an empty queue it answers a short text.
// Each POST /v1/messages is answered as a stream of Server-Sent Events the way the API streams them (message_start,
// content_block_start / delta / stop for thinking, text and tool_use with input_json_delta, message_delta with the
// stop reason and usage, message_stop) and logged to --log as one JSON line { n, path, headers, body }.
// It also rejects, like the real API, a few requests the Assistant must never send: no stream, disabled thinking or a
// thinking budget, forced tool_choice, `fallbacks` without its beta header, strict schemas over the API's limits, and
// histories where a tool call has no result, a result has no call, a message is empty, a photo is not base64, or a
// reply echoes thinking or tool calls from before a fallback block.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_USAGE = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 };
const FALLBACK_BETAS = { default: 'server-side-fallback-2026-07-01', list: 'server-side-fallback-2026-06-01' };

/* ---------- request checks (the subset of the API's own validation that matters here) ---------- */
function schemaStats(schema, stats) {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.type) || schema.anyOf) stats.unions++;
  if (schema.type === 'object' || schema.properties) {
    if (schema.additionalProperties !== false) stats.open++;
    const required = new Set(schema.required || []);
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (!required.has(key)) stats.optional++;
      schemaStats(sub, stats);
    }
  }
  if (schema.items) schemaStats(schema.items, stats);
  for (const sub of schema.anyOf || []) schemaStats(sub, stats);
}

function checkRequest(body, headers) {
  if (!headers['x-api-key'] && !headers.authorization) return [401, 'authentication_error', 'Missing API key.'];
  if (body.stream !== true) return [400, 'invalid_request_error', 'This mock only answers streaming requests.'];
  if (!body.model || !Number.isInteger(body.max_tokens)) return [400, 'invalid_request_error', 'model and max_tokens are required.'];
  if (body.thinking?.type === 'disabled' || body.thinking?.type === 'enabled') {
    return [400, 'invalid_request_error', `"thinking.type.${body.thinking.type}" is not supported for this model.`];
  }
  if (['any', 'tool'].includes(body.tool_choice?.type)) return [400, 'invalid_request_error', 'tool_choice: type "tool" and "any" are not supported for this model.'];
  if (body.fallbacks !== undefined) {
    const beta = String(headers['anthropic-beta'] || '');
    const needed = body.fallbacks === 'default' ? FALLBACK_BETAS.default : FALLBACK_BETAS.list;
    if (!beta.split(',').map((s) => s.trim()).includes(needed)) return [400, 'invalid_request_error', `fallbacks requires the ${needed} beta.`];
  }
  const strict = (body.tools || []).filter((t) => t.strict);
  const stats = { unions: 0, optional: 0, open: 0 };
  for (const tool of strict) schemaStats(tool.input_schema, stats);
  if (strict.length > 20 || stats.unions > 16 || stats.optional > 24 || stats.open) {
    return [400, 'invalid_request_error', `Schema is too complex for compilation (${strict.length} strict tools, ${stats.unions} unions, ${stats.optional} optional, ${stats.open} open objects).`];
  }
  const messages = body.messages || [];
  if (!messages.length || messages[0].role !== 'user') return [400, 'invalid_request_error', 'messages must start with a user message.'];
  for (let i = 0; i < messages.length; i++) {
    const { role, content } = messages[i];
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    if (!Array.isArray(blocks) || !blocks.length) return [400, 'invalid_request_error', `messages.${i}: content must be non-empty.`];
    for (const block of blocks) {
      if (block.type === 'text' && !String(block.text || '').trim()) return [400, 'invalid_request_error', `messages.${i}: text content blocks must be non-empty.`];
      if (block.type === 'image' && block.source?.type !== 'base64' && block.source?.type !== 'url') {
        return [400, 'invalid_request_error', `messages.${i}: image source type ${block.source?.type} is not supported.`];
      }
    }
    const boundary = role === 'assistant' ? blocks.map((b) => b.type).lastIndexOf('fallback') : -1;
    const early = blocks.slice(0, Math.max(boundary, 0)).find((b) => ['thinking', 'redacted_thinking', 'tool_use'].includes(b.type));
    if (early) return [400, 'invalid_request_error', `messages.${i}: ${early.type} blocks before a fallback block must be omitted.`];
    const calls = role === 'assistant' ? blocks.filter((b) => b.type === 'tool_use').map((b) => b.id) : [];
    if (calls.length) {
      const next = messages[i + 1];
      const answered = new Set((Array.isArray(next?.content) ? next.content : []).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id));
      const missing = calls.find((id) => !answered.has(id));
      if (next?.role !== 'user' || missing) return [400, 'invalid_request_error', `messages.${i}: tool_use ids were found without tool_result blocks immediately after: ${missing}.`];
    }
    if (role === 'user') {
      const previous = messages[i - 1];
      const known = new Set(previous?.role === 'assistant' ? previous.content.filter((b) => b.type === 'tool_use').map((b) => b.id) : []);
      const stray = blocks.find((b) => b.type === 'tool_result' && !known.has(b.tool_use_id));
      if (stray) return [400, 'invalid_request_error', `messages.${i}: unexpected tool_use_id found in tool_result blocks: ${stray.tool_use_id}.`];
    }
  }
  return null;
}

/* ---------- streaming one scripted reply ---------- */
const chunks = (text, size) => {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
};

function streamReply(res, reply, n, requested) {
  let model = requested;
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  const usage = { ...DEFAULT_USAGE, ...(reply.usage || {}) };
  const blocks = reply.content || [];
  const stopReason = reply.stop_reason || (blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'request-id': `req_mock_${n}` });
  send('message_start', {
    message: {
      id: `msg_mock_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: usage.input_tokens, output_tokens: 1, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens },
    },
  });
  blocks.forEach((block, index) => {
    if (block.type === 'thinking') {
      send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      send('content_block_delta', { index, delta: { type: 'signature_delta', signature: `sig_mock_${n}_${index}` } });
    } else if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      for (const piece of chunks(block.text, 7)) send('content_block_delta', { index, delta: { type: 'text_delta', text: piece } });
    } else if (block.type === 'tool_use') {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_mock_${n}_${index}`, name: block.name, input: {} } });
      for (const piece of chunks(JSON.stringify(block.input ?? {}), 16)) send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: piece } });
    } else if (block.type === 'fallback') {
      send('content_block_start', { index, content_block: { type: 'fallback', from: { model }, to: { model: block.to || 'claude-opus-5' } } });
      model = block.to || 'claude-opus-5';
    }
    send('content_block_stop', { index });
  });
  send('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null, ...(reply.stop_details ? { stop_details: reply.stop_details } : {}) },
    usage: { output_tokens: usage.output_tokens, input_tokens: usage.input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens },
  });
  send('message_stop', {});
  res.end();
}

/* ---------- the server ---------- */
const readJson = (req) => new Promise((resolve, reject) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    const text = Buffer.concat(parts).toString('utf8');
    try { resolve(text ? JSON.parse(text) : {}); } catch (err) { reject(err); }
  });
  req.on('error', reject);
});

const errorBody = (type, message) => JSON.stringify({ type: 'error', error: { type, message } });

/** Starts the mock; resolves to { server, url, queue, close() }. */
export function startMock({ port = 8932, host = '127.0.0.1', log = null } = {}) {
  const queue = [];
  let n = 0;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://mock').pathname;
    try {
      if (req.method === 'POST' && path === '/__mock/script') {
        const body = await readJson(req);
        for (const reply of [].concat(body)) for (let i = 0; i < (reply.times || 1); i++) queue.push(reply);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ queued: queue.length }));
        return;
      }
      if (req.method === 'POST' && path === '/__mock/reset') {
        queue.length = 0;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
        return;
      }
      if (req.method !== 'POST' || !path.startsWith('/v1/messages')) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(errorBody('not_found_error', 'Not found.'));
        return;
      }
      const body = await readJson(req);
      n += 1;
      const headers = { 'anthropic-beta': req.headers['anthropic-beta'] || null, 'anthropic-version': req.headers['anthropic-version'] || null,
        'x-api-key': req.headers['x-api-key'] ? '(set)' : null };
      if (log) appendFileSync(log, `${JSON.stringify({ n, path, headers, body })}\n`);
      const problem = checkRequest(body, req.headers);
      if (problem) {
        const [status, type, message] = problem;
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(errorBody(type, message));
        return;
      }
      const reply = queue.shift() || { content: [{ type: 'text', text: 'OK.' }] };
      if (reply.status) {
        res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(errorBody(reply.error?.type || 'api_error', reply.error?.message || 'Mock error.'));
        return;
      }
      streamReply(res, reply, n, body.model);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(errorBody('invalid_request_error', String(err.message || err)));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({
      server, queue, url: `http://${host}:${port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

// Run directly: node worker/assistant-mock.mjs --port 8932 --log /tmp/requests.jsonl
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const mock = await startMock({ port: Number(arg('--port', 8932)), log: arg('--log', null) });
  console.log(`Mock Claude API listening on ${mock.url}`);
}
