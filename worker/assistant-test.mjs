#!/usr/bin/env node
// Rome's Joy admin: end-to-end test of the Assistant (docs/assistant-api.md §2–3) against a running local server, with
// worker/assistant-mock.mjs standing in for Claude. It starts the mock itself, so run wrangler dev with:
//   --var ANTHROPIC_API_KEY:test --var ANTHROPIC_BASE_URL:http://127.0.0.1:8932   (or the same two lines in an env file)
//   node worker/assistant-test.mjs [http://localhost:8787] [--mock-port 8932] [--log <requests.jsonl>]
// Against a server without ANTHROPIC_API_KEY, `--no-key` checks that every Assistant route answers 501 instead.
// Env: ADMIN_BOOTSTRAP_TOKEN (default local-dev-token), SMOKE_EMAIL / SMOKE_PASSWORD (the owner it creates on an empty
// database, or logs in with). Prints PASS/FAIL per step and exits 1 on any failure.
// The draft and publish steps use worker/lib/changesets.js; they only check the contract's shapes.
import { crc32, deflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock } from './assistant-mock.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const BASE = (args.find((a) => /^https?:\/\//.test(a)) || 'http://localhost:8787').replace(/\/+$/, '');
const MOCK_PORT = Number(option('--mock-port', 8932));
const LOG = option('--log', join(mkdtempSync(join(tmpdir(), 'assistant-test-')), 'requests.jsonl'));
const BOOTSTRAP_TOKEN = process.env.ADMIN_BOOTSTRAP_TOKEN || 'local-dev-token';
const EMAIL = (process.env.SMOKE_EMAIL || 'smoke-owner@example.com').toLowerCase();
const PASSWORD = process.env.SMOKE_PASSWORD || 'smoke-test-password-1';
const EDITOR_EMAIL = `assistant-editor-${Date.now()}@example.com`;
const EDITOR_PASSWORD = 'assistant-editor-pass-1';
const MODEL = 'claude-opus-5-5';
const PER_CALL = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 50, cache_write_tokens: 10 }; // the mock's default usage
const PER_CALL_COST = (100 * 4 + 20 * 20 + 50 * 0.2 + 10 * 5) / 1e6;

let token = null;
const results = [];
const state = { slug: 'peachs', conversationId: null, changeSetId: null, editorToken: null, mock: null };

/* ---------- tiny client ---------- */
async function api(method, path, body, { auth = token, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (auth) init.headers.Authorization = `Bearer ${auth}`;
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: `not JSON: ${text.slice(0, 120)}` }; }
  return { status: res.status, data, headers: res.headers };
}

/** POSTs and reads a whole text/event-stream reply into [{ event, data }]. Non-stream replies come back as JSON. */
async function sse(path, body, { auth = token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!type.includes('text/event-stream')) {
    let data = null;
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 120) }; }
    return { status: res.status, type, data, events: [] };
  }
  const events = [];
  for (const chunk of text.split('\n\n')) {
    const lines = chunk.split('\n').filter((l) => l && !l.startsWith(':'));
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
    const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
    if (event) events.push({ event, data: data ? JSON.parse(data) : null });
  }
  const of = (name) => events.filter((e) => e.event === name).map((e) => e.data);
  return { status: res.status, type, events, of, text: of('text').map((d) => d.delta).join('') };
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}
const expectStatus = (res, status, what) => expect(res.status === status, `${what}: expected HTTP ${status}, got ${res.status} ${JSON.stringify(res.data)}`);

async function step(name, fn) {
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${note ? `  (${note})` : ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

/* ---------- the mock's request log ---------- */
const logged = () => {
  try { return readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
let logMark = 0;
/** The requests the mock received since the last call. */
function newRequests() {
  const all = logged();
  const fresh = all.slice(logMark);
  logMark = all.length;
  return fresh;
}
const script = (replies) => fetch(`${state.mock.url}/__mock/script`, { method: 'POST', body: JSON.stringify(replies) });
const resetMock = () => fetch(`${state.mock.url}/__mock/reset`, { method: 'POST' });

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Each request's messages must start with every message of the one before (append-only history). */
function expectAppendOnly(requests, what) {
  for (let i = 1; i < requests.length; i++) {
    const before = requests[i - 1].body.messages;
    const after = requests[i].body.messages;
    expect(after.length > before.length, `${what}: request ${i + 1} has no new messages`);
    const firstDiff = before.findIndex((m, j) => !same(m, after[j]));
    expect(firstDiff === -1, `${what}: request ${i + 1} changed message ${firstDiff} of the history`);
  }
}

const chicagoToday = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

/** A real width×height RGB PNG, so the photo step needs no fixture file. */
function tinyPng(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rowLength = 1 + width * 3;
  const pixels = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set([0xf4, 0xa2, 0x61], y * rowLength + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

/* =========================================================================
   Sign in
   ========================================================================= */
await step('Sign in as an owner', async () => {
  const status = await api('GET', '/api/auth/status', undefined, { auth: null });
  expectStatus(status, 200, 'status');
  const res = status.data.has_users
    ? await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD }, { auth: null })
    : await api('POST', '/api/auth/bootstrap', { token: BOOTSTRAP_TOKEN, email: EMAIL, password: PASSWORD, name: 'Smoke Owner' }, { auth: null });
  expectStatus(res, 200, status.data.has_users ? 'login' : 'bootstrap');
  token = res.data.token;
  return EMAIL;
});
if (!token) {
  console.log('\nCannot continue without a session.');
  process.exit(1);
}

/* =========================================================================
   --no-key: a server without ANTHROPIC_API_KEY answers 501 on every Assistant route
   ========================================================================= */
if (flag('--no-key')) {
  await step('Every Assistant route answers 501 assistant_not_configured without a key', async () => {
    const calls = [
      ['GET', '/api/admin/assistant/conversations'],
      ['POST', '/api/admin/assistant/conversations', { business_slug: null }],
      ['GET', '/api/admin/assistant/conversations/nope'],
      ['POST', '/api/admin/assistant/conversations/nope/messages', { text: 'Hello' }],
      ['POST', '/api/admin/assistant/conversations/nope/published', { change_set_id: 'x' }],
      ['GET', '/api/admin/assistant/usage?days=30'],
    ];
    for (const [method, path, body] of calls) {
      const res = await api(method, path, body);
      expectStatus(res, 501, `${method} ${path}`);
      expect(res.data.code === 'assistant_not_configured' && /not switched on/i.test(res.data.error), `${path}: code and plain message`);
    }
    const anon = await api('GET', '/api/admin/assistant/conversations', undefined, { auth: null });
    expectStatus(anon, 401, 'signed out still gets 401 first');
    return `${calls.length} routes`;
  });
} else {
  writeFileSync(LOG, '');
  state.mock = await startMock({ port: MOCK_PORT, log: LOG });
  await runAssistantSteps();
  await state.mock.close();
}

/* =========================================================================
   The Assistant against the mock
   ========================================================================= */
async function runAssistantSteps() {
  await step('POST /api/admin/assistant/conversations', async () => {
    const res = await api('POST', '/api/admin/assistant/conversations', { business_slug: state.slug });
    expectStatus(res, 200, 'create');
    const c = res.data.conversation;
    expect(c && typeof c.id === 'string' && c.id.length >= 20 && c.business_slug === state.slug, `conversation shape ${JSON.stringify(c)}`);
    state.conversationId = c.id;
    const unknown = await api('POST', '/api/admin/assistant/conversations', { business_slug: 'no-such-business' });
    expectStatus(unknown, 404, 'unknown business');
    return c.id;
  });

  const noticeUntil = chicagoToday(5);
  const noticeArgs = { notice: 'We close at 1 pm this Friday for a private event.', notice_until: noticeUntil };
  let turn1 = null;
  await step('A turn: get_business → propose_changes → reply, streamed as events', async () => {
    await resetMock();
    newRequests();
    await script([
      { content: [{ type: 'thinking' }, { type: 'text', text: 'Let me look at the current notice.' }, { type: 'tool_use', name: 'get_business', input: { slug: state.slug } }] },
      { content: [{ type: 'thinking' }, { type: 'tool_use', name: 'propose_changes', input: {
        title: 'Close early Friday',
        ops: [{ op: 'business.patch', business_slug: state.slug, args_json: JSON.stringify(noticeArgs) }],
        replace_change_set_id: null,
      } }] },
      { content: [{ type: 'thinking' }, { type: 'text', text: 'Here is the draft. Nothing is live until you tap Publish.' }] },
    ]);
    turn1 = await sse(`/api/admin/assistant/conversations/${state.conversationId}/messages`, { text: 'Put up a notice that we close at 1 pm this Friday.' });
    expect(turn1.status === 200 && turn1.type.includes('text/event-stream'), `expected an event stream, got ${turn1.status} ${turn1.type} ${JSON.stringify(turn1.data)}`);
    expect(!turn1.of('error').length, `no error event: ${JSON.stringify(turn1.of('error'))}`);
    expect(turn1.text.includes('Let me look at the current notice.') && turn1.text.includes('Nothing is live until you tap Publish.'), `text deltas: ${turn1.text}`);
    expect(turn1.text.includes('notice.\n\nHere is'), 'a paragraph break between the replies of two requests');
    const tools = turn1.of('tool');
    expect(tools.length === 2 && tools[0].name === 'get_business' && tools[1].name === 'propose_changes', `tool events ${JSON.stringify(tools)}`);
    expect(tools[0].label === 'Looking at the details and hours for Peach\'s…' && tools[1].label === 'Drafting the changes…', `friendly labels ${JSON.stringify(tools)}`);
    const done = turn1.of('done');
    expect(done.length === 1 && Number.isInteger(done[0].message_id), `one done event with message_id ${JSON.stringify(done)}`);
    const usage = done[0].usage;
    expect(usage.input_tokens === 300 && usage.output_tokens === 60 && usage.cache_read_tokens === 150 && usage.cache_write_tokens === 30, `turn usage adds up 3 calls ${JSON.stringify(usage)}`);
    expect(Math.abs(usage.cost_usd - 3 * PER_CALL_COST) < 1e-9, `cost at $4/$20 per million, cache reads $0.20, writes $5: ${usage.cost_usd}`);
    expect(turn1.events[turn1.events.length - 1].event === 'done', 'done is the last event');
    return `${turn1.of('text').length} text deltas`;
  });

  await step('The draft event carries the change set (contract shape)', async () => {
    const drafts = turn1?.of('draft') || [];
    expect(drafts.length === 1, `one draft event, got ${drafts.length}`);
    const cs = drafts[0].change_set;
    for (const key of ['id', 'title', 'status', 'summary', 'checks', 'preview_urls']) expect(key in cs, `change_set.${key}`);
    expect(cs.status === 'draft' && cs.title === 'Close early Friday', `draft status/title ${cs.status} ${cs.title}`);
    expect(Array.isArray(cs.summary) && cs.summary.length >= 1 && Array.isArray(cs.preview_urls) && cs.preview_urls.length >= 1, 'summary and preview links');
    state.changeSetId = cs.id;
    return cs.id;
  });

  await step('Requests to Claude follow the contract (model, effort, tools, fallbacks, caching)', async () => {
    const requests = newRequests();
    expect(requests.length === 3, `3 requests, got ${requests.length}`);
    for (const [i, { body, headers, path }] of requests.entries()) {
      const at = `request ${i + 1}`;
      expect(path.startsWith('/v1/messages') && headers['x-api-key'] === '(set)', `${at}: path ${path}, key ${headers['x-api-key']}`);
      expect(body.model === MODEL && body.max_tokens === 16000 && body.stream === true, `${at}: model/max_tokens/stream`);
      expect(same(body.output_config, { effort: 'medium' }), `${at}: output_config ${JSON.stringify(body.output_config)}`);
      expect(same(body.thinking, { type: 'adaptive' }), `${at}: adaptive thinking ${JSON.stringify(body.thinking)}`);
      expect(!JSON.stringify(body).includes('budget_tokens'), `${at}: no budget_tokens`);
      expect(same(body.tool_choice, { type: 'auto' }), `${at}: tool_choice auto`);
      expect(body.fallbacks === 'default' && String(headers['anthropic-beta']).split(',').includes('server-side-fallback-2026-07-01'), `${at}: fallbacks default + beta header`);
      const system = body.system;
      expect(Array.isArray(system) && system.length && same(system[system.length - 1].cache_control, { type: 'ephemeral' }), `${at}: cache_control on the last system block`);
      expect(!/\d{4}-\d{2}-\d{2}/.test(JSON.stringify(system)), `${at}: no dates in the frozen system prompt`);
      expect(same(body.cache_control, { type: 'ephemeral' }), `${at}: automatic cache breakpoint for the conversation`);
      const names = body.tools.map((t) => t.name);
      expect(!names.includes('get_publish_link') && !names.includes('publish_change_set') && names.includes('propose_changes') && names.includes('verify_change_set') && names.includes('list_photos'), `${at}: tool list ${names}`);
      for (const tool of body.tools) {
        expect(tool.strict === true, `${at}: ${tool.name} is strict`);
        const s = tool.input_schema;
        expect(s.type === 'object' && s.additionalProperties === false && same([...s.required].sort(), Object.keys(s.properties).sort()), `${at}: ${tool.name} schema closed, every property required`);
      }
      if (i) expect(same(body.tools, requests[0].body.tools) && same(body.system, requests[0].body.system), `${at}: tools and system byte-identical`);
    }
    expectAppendOnly(requests, 'turn 1');
    const firstUser = requests[0].body.messages[0];
    expect(firstUser.role === 'user' && firstUser.content[0].text.includes(`Today's date is ${chicagoToday()}`) && firstUser.content[0].text.includes('owner'), 'first message carries today and who is asking');
    const second = requests[1].body.messages;
    const assistant = second[1];
    expect(assistant.role === 'assistant' && assistant.content[0].type === 'thinking' && assistant.content[0].signature, 'thinking block replayed with its signature');
    const results = second[2].content;
    expect(second[2].role === 'user' && results.length === 1 && results[0].type === 'tool_result' && results[0].tool_use_id === assistant.content[2].id, 'one tool_result per tool_use, in one user message');
    const business = JSON.parse(results[0].content);
    expect(business.business?.slug === state.slug && Array.isArray(business.weekly_hours) && business.weekly_hours.length === 7, 'get_business result');
    return `${requests[0].body.tools.length} strict tools`;
  });

  await step('GET the conversation renders text, tool lines and drafts (no thinking)', async () => {
    const res = await api('GET', `/api/admin/assistant/conversations/${state.conversationId}`);
    expectStatus(res, 200, 'get');
    const { conversation, messages } = res.data;
    expect(conversation.id === state.conversationId && conversation.title.startsWith('Put up a notice'), `title ${conversation.title}`);
    expect(messages.length === 2 && messages[0].role === 'user' && messages[1].role === 'assistant', `two entries ${JSON.stringify(messages.map((m) => m.role))}`);
    expect(messages[0].text === 'Put up a notice that we close at 1 pm this Friday.' && messages[0].attachments_count === 0, `user text only ${JSON.stringify(messages[0].text)}`);
    expect(messages[1].text.includes('Let me look') && messages[1].text.includes('Here is the draft'), 'assistant text joined');
    expect(same(messages[1].drafts, [state.changeSetId]), `drafts ${JSON.stringify(messages[1].drafts)}`);
    expect(!JSON.stringify(res.data).includes('signature') && !JSON.stringify(res.data).includes('thinking'), 'no thinking content');
    const list = await api('GET', '/api/admin/assistant/conversations');
    expectStatus(list, 200, 'list');
    expect(list.data.conversations[0]?.id === state.conversationId, 'newest first');
  });

  await step('A second turn appends to the same history', async () => {
    const before = logged().slice(-1)[0];
    await script([{ content: [{ type: 'text', text: 'You’re welcome.' }] }]);
    const res = await sse(`/api/admin/assistant/conversations/${state.conversationId}/messages`, { text: 'Thanks!' });
    expect(res.of('done').length === 1 && !res.of('error').length, `done ${JSON.stringify(res.of('error'))}`);
    const [request] = newRequests();
    expectAppendOnly([before, request], 'turn 2');
    const added = request.body.messages.slice(before.body.messages.length);
    expect(added.length === 2 && added[0].role === 'assistant' && added[1].role === 'user', `adds the last reply and the new message ${JSON.stringify(added.map((m) => m.role))}`);
    expect(added[1].content.length === 1 && added[1].content[0].text === 'Thanks!', 'no repeated context note on later turns');
  });

  await step('One turn at a time: a message sent while a reply is still running gets 409 turn_in_progress', async () => {
    const path = `/api/admin/assistant/conversations/${state.conversationId}/messages`;
    const before = logged().slice(-1)[0];
    await script([{ content: [{ type: 'text', text: 'That took a while.' }], delay_ms: 3000 }, { content: [{ type: 'text', text: 'Here now.' }] }]);
    // The phone drops the reply part-way (the screen locks): the server carries on with the turn.
    const dropped = new AbortController();
    const first = fetch(`${BASE}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Take your time.' }), signal: dropped.signal });
    expect((await first).status === 200, 'the reply started');
    dropped.abort();
    const busy = await api('GET', `/api/admin/assistant/conversations/${state.conversationId}`);
    expect(busy.data.conversation.busy === true, `busy while the reply runs ${JSON.stringify(busy.data.conversation)}`);
    const second = await sse(path, { text: 'Hello? Are you there?' });
    expect(second.status === 409 && second.data.code === 'turn_in_progress' && /still finishing/.test(second.data.error), `second message ${second.status} ${JSON.stringify(second.data)}`);
    let after;
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => { setTimeout(resolve, 250); });
      after = (await api('GET', `/api/admin/assistant/conversations/${state.conversationId}`)).data;
      if (!after.conversation.busy) break;
    }
    expect(after.conversation.busy === false && after.messages.at(-1).text === 'That took a while.', `the turn finished on the server ${JSON.stringify(after.messages.at(-1))}`);
    expect(!after.messages.some((m) => m.text === 'Hello? Are you there?'), 'the refused message was not stored');
    const third = await sse(path, { text: 'Hello again.' });
    expect(third.of('done').length === 1, 'the next message goes through once it is done');
    expectAppendOnly([before, ...newRequests()], 'after a dropped reply');
  });

  await step('Validation: invalid tool input and bad change sets come back to Claude as errors', async () => {
    await script([
      { content: [{ type: 'tool_use', name: 'propose_changes', input: { title: 'Bad', ops: [{ op: 'business.patch', business_slug: state.slug, args_json: 'not json' }], replace_change_set_id: null } }] },
      { content: [{ type: 'tool_use', name: 'get_business', input: { slug: 'no-such-business' } }] },
      { content: [{ type: 'text', text: 'Sorry, let me fix that.' }] },
    ]);
    const res = await sse(`/api/admin/assistant/conversations/${state.conversationId}/messages`, { text: 'Try a broken change.' });
    expect(res.of('done').length === 1 && !res.of('draft').length, 'no draft for invalid input');
    const requests = newRequests();
    const results = requests.slice(1).map((r) => r.body.messages[r.body.messages.length - 1].content[0]);
    expect(results[0].is_error === true && JSON.parse(results[0].content).details?.[0]?.op_index === 0, `args_json problem with details ${results[0].content}`);
    expect(results[1].is_error === true && /No such business/i.test(JSON.parse(results[1].content).error), `unknown business ${results[1].content}`);
  });

  await step('A refusal ends the turn with a plain message and keeps the history valid', async () => {
    await script([
      { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } },
      { content: [{ type: 'text', text: 'Back to work.' }] },
    ]);
    const refused = await sse(`/api/admin/assistant/conversations/${state.conversationId}/messages`, { text: 'Something odd.' });
    expect(/can’t help with that request/.test(refused.text) && refused.of('done').length === 1, `refusal text ${refused.text}`);
    const view = await api('GET', `/api/admin/assistant/conversations/${state.conversationId}`);
    const shown = view.data.messages.slice(-2).map((m) => `${m.role}: ${m.text}`);
    expect(same(shown, ['user: Something odd.', 'assistant: Sorry, I can’t help with that request.']), `the reply is kept for the chat ${JSON.stringify(shown)}`);
    const next = await sse(`/api/admin/assistant/conversations/${state.conversationId}/messages`, { text: 'OK, never mind.' });
    expect(next.text === 'Back to work.' && !next.of('error').length, `next turn works ${JSON.stringify(next.of('error'))}`);
    expectAppendOnly(newRequests(), 'after a refusal');
  });

  await step('The 12-round cap stops a runaway turn with a gentle error', async () => {
    const created = await api('POST', '/api/admin/assistant/conversations', { business_slug: null });
    const id = created.data.conversation.id;
    // 12 rounds of tools run; when Claude asks for a 13th the turn ends and those calls get error results.
    await script({ content: [{ type: 'tool_use', name: 'list_businesses', input: {} }], times: 13 });
    const res = await sse(`/api/admin/assistant/conversations/${id}/messages`, { text: 'Keep checking forever.' });
    const requests = newRequests();
    expect(requests.length === 13, `13 requests to Claude, got ${requests.length}`);
    expect(res.of('tool').length === 12, `12 rounds of tools ran, got ${res.of('tool').length}`);
    expect(!res.of('done').length, 'no done event after the error');
    const errors = res.of('error');
    expect(errors.length === 1 && errors[0].code === 'too_many_steps' && /more steps/.test(errors[0].error), `error event ${JSON.stringify(errors)}`);
    expectAppendOnly(requests, 'capped turn');
    await resetMock();
    await script([{ content: [{ type: 'text', text: 'Still here.' }] }]);
    const after = await sse(`/api/admin/assistant/conversations/${id}/messages`, { text: 'Hello again.' });
    expect(after.text === 'Still here.' && !after.of('error').length, `the chat still works ${JSON.stringify(after.of('error'))}`);
    const [request] = newRequests();
    const tail = request.body.messages.slice(-2);
    expect(tail[0].content.every((b) => b.type === 'tool_result' && b.is_error), 'the unrun calls got error results');
    state.cappedConversationId = id;
    return '12 rounds, 13 requests';
  });

  await step('A refusal fallback mid-reply: stored as received, replayed without the declined part', async () => {
    await script([
      { content: [
        { type: 'thinking' }, { type: 'text', text: 'Let me look.' }, { type: 'tool_use', name: 'get_business', input: { slug: state.slug } },
        { type: 'fallback', to: 'claude-opus-5' },
        { type: 'thinking' }, { type: 'text', text: 'Checking the hours.' }, { type: 'tool_use', name: 'list_businesses', input: {} },
      ] },
      { content: [{ type: 'text', text: 'All good.' }] },
    ]);
    const res = await sse(`/api/admin/assistant/conversations/${state.cappedConversationId}/messages`, { text: 'What are the hours?' });
    expect(res.of('done').length === 1 && !res.of('error').length, `done ${JSON.stringify(res.of('error'))}`);
    const tools = res.of('tool');
    expect(tools.length === 1 && tools[0].name === 'list_businesses', `only the call after the switch ran ${JSON.stringify(tools)}`);
    expect(res.text === 'Let me look.\n\nChecking the hours.\n\nAll good.', `text ${JSON.stringify(res.text)}`);
    const [, second] = newRequests();
    const echoed = second.body.messages[second.body.messages.length - 2];
    expect(same(echoed.content.map((b) => b.type), ['text', 'fallback', 'thinking', 'text', 'tool_use']), `echoed reply ${echoed.content.map((b) => b.type)}`);
    await script([{ content: [{ type: 'text', text: 'Yes.' }] }]);
    const again = await sse(`/api/admin/assistant/conversations/${state.cappedConversationId}/messages`, { text: 'Sure?' });
    const [third] = newRequests();
    expect(again.of('done').length === 1 && same(third.body.messages.slice(0, second.body.messages.length), second.body.messages), 'replayed the same on the next turn');
    const view = await api('GET', `/api/admin/assistant/conversations/${state.cappedConversationId}`);
    const reply = view.data.messages.find((m) => m.text.startsWith('Let me look.'));
    expect(reply && same(reply.tools, ['Looking at your businesses…']), `rendered tool lines ${JSON.stringify(reply?.tools)}`);
  });

  await step('Photos: sent to Claude as base64, counted, and bad files refused', async () => {
    const png = tinyPng(4, 3).toString('base64');
    await script([{ content: [{ type: 'text', text: 'Nice photo.' }] }]);
    const res = await sse(`/api/admin/assistant/conversations/${state.conversationId}/messages`, { text: 'Read this.', images: [{ media_type: 'image/png', data_base64: png }] });
    expect(res.status === 200 && res.of('done').length === 1, `photo turn ${res.status} ${JSON.stringify(res.data || res.of('error'))}`);
    const [request] = newRequests();
    const last = request.body.messages[request.body.messages.length - 1];
    const image = last.content.find((b) => b.type === 'image');
    expect(image && image.source.type === 'base64' && image.source.media_type === 'image/png' && image.source.data === png, 'image block with the same bytes');
    const view = await api('GET', `/api/admin/assistant/conversations/${state.conversationId}`);
    const entry = view.data.messages.find((m) => m.text === 'Read this.');
    expect(entry?.attachments_count === 1, 'attachments_count');
    const wrong = await sse(`/api/admin/assistant/conversations/${state.conversationId}/messages`, { text: 'x', images: [{ media_type: 'image/jpeg', data_base64: png }] });
    expect(wrong.status === 400 && wrong.data.code === 'unsupported_type', `PNG bytes labelled JPEG ${wrong.status} ${JSON.stringify(wrong.data)}`);
    const tooMany = await sse(`/api/admin/assistant/conversations/${state.conversationId}/messages`, { images: Array(5).fill({ media_type: 'image/png', data_base64: png }) });
    expect(tooMany.status === 400 && tooMany.data.code === 'too_many_images', 'more than 4 photos');
    const replay = await sse(`/api/admin/assistant/conversations/${state.conversationId}/messages`, { text: 'And again?' });
    const [again] = newRequests();
    expect(replay.of('done').length === 1 && same(again.body.messages.slice(0, request.body.messages.length), request.body.messages), 'the photo replays byte-identical');
  });

  await step('Bad requests: empty message, unknown chat, someone else\'s chat', async () => {
    const empty = await sse(`/api/admin/assistant/conversations/${state.conversationId}/messages`, { text: '   ' });
    expect(empty.status === 400 && empty.data.code === 'missing_field', `empty ${empty.status}`);
    const unknown = await sse('/api/admin/assistant/conversations/nope/messages', { text: 'Hi' });
    expect(unknown.status === 404, `unknown ${unknown.status}`);
    const made = await api('POST', '/api/admin/users', { email: EDITOR_EMAIL, name: 'Assistant Editor', password: EDITOR_PASSWORD, role: 'editor', businesses: ['blanc'] });
    expectStatus(made, 200, 'create editor');
    const login = await api('POST', '/api/auth/login', { email: EDITOR_EMAIL, password: EDITOR_PASSWORD }, { auth: null });
    expectStatus(login, 200, 'editor login');
    state.editorToken = login.data.token;
    const theirs = await api('GET', `/api/admin/assistant/conversations/${state.conversationId}`, undefined, { auth: state.editorToken });
    expectStatus(theirs, 404, 'another person\'s chat');
    const notTheirs = await api('POST', '/api/admin/assistant/conversations', { business_slug: 'peachs' }, { auth: state.editorToken });
    expectStatus(notTheirs, 403, 'a business the editor cannot edit');
    const usage = await api('GET', '/api/admin/assistant/usage', undefined, { auth: state.editorToken });
    expectStatus(usage, 403, 'usage is for owners and admins');
  });

  await step('An editor\'s tools stay inside their businesses', async () => {
    const created = await api('POST', '/api/admin/assistant/conversations', { business_slug: 'blanc' }, { auth: state.editorToken });
    expectStatus(created, 200, 'editor chat');
    const draftForPeachs = {
      title: 'New notice', replace_change_set_id: null,
      ops: [{ op: 'business.patch', business_slug: 'peachs', args_json: JSON.stringify({ notice: 'Closed Monday.', notice_until: null }) }],
    };
    await script([
      { content: [
        { type: 'tool_use', name: 'get_menu', input: { slug: 'peachs' } },
        { type: 'tool_use', name: 'list_businesses', input: {} },
        { type: 'tool_use', name: 'propose_changes', input: draftForPeachs },
      ] },
      { content: [{ type: 'text', text: 'I can only help with Blanc.' }] },
    ]);
    const res = await sse(`/api/admin/assistant/conversations/${created.data.conversation.id}/messages`, { text: 'Change the Peach\'s menu.' }, { auth: state.editorToken });
    expect(res.of('done').length === 1, 'done');
    expect(!res.of('draft').length, `no draft for a business they cannot edit ${JSON.stringify(res.of('draft'))}`);
    const [first, second] = newRequests();
    expect(/editor and can edit only: Blanc \(blanc\)/.test(first.body.messages[0].content[0].text), 'the note names their businesses');
    const [menu, businesses, draft] = second.body.messages[second.body.messages.length - 1].content;
    expect(menu.is_error && /only edit the businesses assigned/i.test(JSON.parse(menu.content).error), `menu refused ${menu.content}`);
    const slugs = JSON.parse(businesses.content).businesses.map((b) => b.slug);
    expect(same(slugs, ['blanc']), `list_businesses shows only theirs ${slugs}`);
    const refused = JSON.parse(draft.content);
    expect(draft.is_error && refused.code === 'invalid_change_set' && /"peachs" is not one of them/.test(refused.details?.[0]?.message), `draft refused ${draft.content}`);
    const theirs = await api('GET', '/api/admin/change-sets?status=all', undefined, { auth: state.editorToken });
    expectStatus(theirs, 200, 'editor change sets');
    expect(theirs.data.change_sets.length === 0, `nothing stored for them ${JSON.stringify(theirs.data.change_sets.map((c) => c.id))}`);
  });

  await step('Published follow-up: Claude verifies and reports back', async () => {
    expect(state.changeSetId, 'needs the draft from the first turn');
    const notYet = await sse(`/api/admin/assistant/conversations/${state.conversationId}/published`, { change_set_id: state.changeSetId });
    expect(notYet.status === 409 && notYet.data.code === 'not_published', `before publishing ${notYet.status} ${JSON.stringify(notYet.data)}`);
    const pub = await api('POST', `/api/admin/change-sets/${state.changeSetId}/publish`, {});
    expectStatus(pub, 200, 'publish (change-set route)');
    await script([
      { content: [{ type: 'tool_use', name: 'verify_change_set', input: { id: state.changeSetId } }] },
      { content: [{ type: 'text', text: 'It is live on the website.' }] },
    ]);
    const res = await sse(`/api/admin/assistant/conversations/${state.conversationId}/published`, { change_set_id: state.changeSetId });
    expect(res.status === 200 && res.of('done').length === 1 && !res.of('error').length, `follow-up ${res.status} ${JSON.stringify(res.data || res.of('error'))}`);
    expect(res.of('tool')[0]?.label === 'Checking the live website…', 'verify label');
    const [request, second] = newRequests();
    const asked = request.body.messages[request.body.messages.length - 1].content;
    // The system's words only (the title was written by Claude); a date note only when the day has changed.
    expect(asked[0].text === `[Back office note: written by the system] The person published change set ${state.changeSetId}.`
      && asked.every((b) => b.type === 'text' && b.text.startsWith('[Back office note')), `published message ${JSON.stringify(asked)}`);
    const verified = JSON.parse(second.body.messages[second.body.messages.length - 1].content[0].content);
    expect(typeof verified.ok === 'boolean' && Array.isArray(verified.lines), `verify result ${JSON.stringify(verified)}`);
    const again = await sse(`/api/admin/assistant/conversations/${state.conversationId}/published`, { change_set_id: state.changeSetId });
    expect(again.status === 409 && again.data.code === 'already_reported', `a second follow-up ${again.status} ${JSON.stringify(again.data)}`);
    const other = await api('POST', '/api/admin/assistant/conversations', { business_slug: null });
    const elsewhere = await sse(`/api/admin/assistant/conversations/${other.data.conversation.id}/published`, { change_set_id: state.changeSetId });
    expect(elsewhere.status === 409 && elsewhere.data.code === 'not_in_chat', `another chat ${elsewhere.status} ${JSON.stringify(elsewhere.data)}`);
    expect(newRequests().length === 0, 'Claude was not called for the refused follow-ups');
    const shown = (await api('GET', `/api/admin/assistant/conversations/${state.conversationId}`)).data.messages;
    expect(!shown.some((m) => m.role === 'user' && !m.text), 'the system note is not shown as an empty message');
    // Put the local site back the way it was (the change-set route from docs/assistant-api.md §1).
    await api('POST', `/api/admin/change-sets/${state.changeSetId}/undo`, {});
    return verified.ok ? 'verified' : 'verify said not yet';
  });

  await step('Usage: a row per call, cost estimate, totals per day and per user', async () => {
    const before = await api('GET', '/api/admin/assistant/usage?days=7');
    expectStatus(before, 200, 'usage');
    await script([
      { content: [{ type: 'tool_use', name: 'list_businesses', input: {} }] },
      { content: [{ type: 'text', text: 'Those are your businesses.' }] },
    ]);
    const turn = await sse(`/api/admin/assistant/conversations/${state.conversationId}/messages`, { text: 'Which businesses can I edit?' });
    expect(turn.of('done').length === 1, 'turn');
    expect(newRequests().length === 2, 'two calls');
    const res = await api('GET', '/api/admin/assistant/usage?days=7');
    const diff = (key) => res.data.totals[key] - before.data.totals[key];
    expect(diff('calls') === 2 && diff('turns') === 1, `one usage row per call: +${diff('calls')} calls, +${diff('turns')} turns`);
    expect(diff('input_tokens') === 2 * PER_CALL.input_tokens && diff('output_tokens') === 2 * PER_CALL.output_tokens
      && diff('cache_read_tokens') === 2 * PER_CALL.cache_read_tokens && diff('cache_write_tokens') === 2 * PER_CALL.cache_write_tokens, 'token totals');
    expect(Math.abs(diff('cost_usd') - 2 * PER_CALL_COST) <= 0.0001, `cost estimate +${diff('cost_usd')}`);
    const { by_day: byDay, by_user: byUser, this_month: month, totals } = res.data;
    expect(byDay.length === 7 && byDay[6].date === chicagoToday(), `7 days ending today ${byDay.map((d) => d.date)}`);
    expect(byDay[6].calls >= 2 && month.calls >= byDay[6].calls && totals.calls >= byDay[6].calls, 'today is in the week and the month');
    const me = byUser.find((u) => u.email === EMAIL);
    expect(me && me.calls >= 2 && me.turns >= 1 && me.cost_usd > 0, `per-user row ${JSON.stringify(me)}`);
    return `${totals.calls} calls this week, $${totals.cost_usd}`;
  });

  await step('A long chat asks for a new one instead of trimming', async () => {
    const created = await api('POST', '/api/admin/assistant/conversations', { business_slug: null });
    const id = created.data.conversation.id;
    await script([{ content: [{ type: 'text', text: 'Big.' }], usage: { input_tokens: 2000, cache_read_input_tokens: 150000 } }]);
    const first = await sse(`/api/admin/assistant/conversations/${id}/messages`, { text: 'Hello' });
    expect(first.of('done').length === 1, 'first turn');
    const second = await sse(`/api/admin/assistant/conversations/${id}/messages`, { text: 'Hello again' });
    expect(second.status === 409 && second.data.code === 'conversation_too_long' && /new chat/.test(second.data.error), `long chat ${second.status} ${JSON.stringify(second.data)}`);
    newRequests();
  });

  await step('Daily limit: two messages at once at the last one left: one goes through', async () => {
    const before = await api('GET', '/api/admin/settings/assistant:limits');
    const usage = (await api('GET', '/api/admin/assistant/usage?days=1')).data;
    const mine = usage.by_user.find((u) => u.email === EMAIL)?.turns || 0;
    await api('PUT', '/api/admin/settings/assistant:limits', { value: { daily_turns: mine + 1 } });
    try {
      const chats = await Promise.all([0, 1].map(() => api('POST', '/api/admin/assistant/conversations', { business_slug: null })));
      await script([{ content: [{ type: 'text', text: 'One.' }] }, { content: [{ type: 'text', text: 'Two.' }] }]);
      const answers = await Promise.all(chats.map((c) => sse(`/api/admin/assistant/conversations/${c.data.conversation.id}/messages`, { text: 'At the same time.' })));
      const codes = answers.map((a) => a.status).sort();
      expect(same(codes, [200, 429]) && answers.find((a) => a.status === 429).data.code === 'assistant_limit', `statuses ${JSON.stringify(answers.map((a) => [a.status, a.data?.code]))}`);
      expect(newRequests().length === 1, 'Claude was called once');
      await resetMock();
    } finally {
      await api('PUT', '/api/admin/settings/assistant:limits', { value: before.data.value || {} });
    }
  });

  await step('Daily limit: 429 assistant_limit with a friendly message', async () => {
    const before = await api('GET', '/api/admin/settings/assistant:limits');
    expectStatus(before, 200, 'read the limit');
    const set = await api('PUT', '/api/admin/settings/assistant:limits', { value: { daily_turns: 1 } });
    expectStatus(set, 200, 'lower the limit');
    try {
      const res = await sse(`/api/admin/assistant/conversations/${state.conversationId}/messages`, { text: 'One more?' });
      expect(res.status === 429 && res.data.code === 'assistant_limit' && /resets at midnight/.test(res.data.error), `limit ${res.status} ${JSON.stringify(res.data)}`);
      expect(newRequests().length === 0, 'Claude was not called');
    } finally {
      await api('PUT', '/api/admin/settings/assistant:limits', { value: before.data.value || {} });
    }
  });
}

/* ---------- summary ---------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.name).join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
