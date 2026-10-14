#!/usr/bin/env node
// Rome's Joy admin: end-to-end test of the Claude app connector (docs/assistant-api.md §4, worker/lib/mcp.js) against a
// running local server, acting as Claude would: discovery metadata → dynamic client registration → /authorize with
// PKCE (the sign-in and consent pages, driven with plain form posts) → token → MCP over Streamable HTTP (initialize,
// tools/list, tools/call) → draft, a link to publish it in the back office (Claude cannot publish), the person
// publishing there, verify → disconnect on the connected-apps route. It also checks that sign-in lockouts are shared
// with /api/auth/login, that a sign-in only sends its code to Claude and only with PKCE, that registrations are capped
// per address, and that an editor's connection follows their permissions and stops working (for good) when their
// password changes or they are switched off.
//   npx wrangler dev --local --port 8787        (in another terminal, after applying the schema and migrations)
//   node worker/mcp-test.mjs [http://localhost:8787]
// Env: ADMIN_BOOTSTRAP_TOKEN (default local-dev-token), SMOKE_EMAIL / SMOKE_PASSWORD (the owner it creates on an empty
// database, or logs in with). Prints PASS/FAIL per step and exits 1 on any failure. The published change is undone and
// the test editor removed at the end.
// Form posts carry a random CF-Connecting-IP so repeated runs do not trip the per-IP sign-in limit on a local server
// (Cloudflare replaces that header in production, so it has no effect there).
import { createHash, randomBytes } from 'node:crypto';

const BASE = (process.argv[2] || 'http://localhost:8787').replace(/\/+$/, '');
const BOOTSTRAP_TOKEN = process.env.ADMIN_BOOTSTRAP_TOKEN || 'local-dev-token';
const EMAIL = (process.env.SMOKE_EMAIL || 'smoke-owner@example.com').toLowerCase();
const PASSWORD = process.env.SMOKE_PASSWORD || 'smoke-test-password-1';
const EDITOR_EMAIL = `mcp-editor-${Date.now()}@example.com`;
const EDITOR_PASSWORDS = ['mcp-editor-start-1', 'mcp-editor-mine-2', 'mcp-editor-mine-3'];
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const randomIp = () => `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
const FORM_IP = { 'CF-Connecting-IP': randomIp() };
const SLUG = 'peachs';

let token = null; // the owner's back office session
const results = [];
const state = { client: null, owner: null, changeSetId: null, appId: null, editorId: null, editor: null };

/* ---------- tiny clients ---------- */
async function api(method, path, body, { auth = token, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, redirect: 'manual' };
  if (auth) init.headers.Authorization = `Bearer ${auth}`;
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: `not JSON: ${text.slice(0, 120)}` }; }
  return { status: res.status, data, headers: res.headers };
}

/** Posts an HTML form (application/x-www-form-urlencoded) the way a browser would; never follows redirects. */
async function postForm(path, fields, { cookie = '', ip = FORM_IP } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams(fields),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...ip, ...(cookie ? { Cookie: cookie } : {}) },
  });
  return { status: res.status, html: await res.text(), headers: res.headers };
}

/** POSTs form fields to the token endpoint and reads the JSON answer. */
async function tokenRequest(fields) {
  const res = await fetch(`${BASE}/token`, { method: 'POST', body: new URLSearchParams(fields), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/** One JSON-RPC request over MCP Streamable HTTP. The reply is JSON or a short SSE stream; both come back as the message. */
let rpcId = 0;
async function mcp(accessToken, method, params, { notification = false } = {}) {
  const message = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notification ? {} : { id: ++rpcId }) };
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify(message),
  });
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  let reply = null;
  if (type.includes('text/event-stream')) {
    const data = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    reply = data.find((m) => m.id === message.id) || data[data.length - 1] || null;
  } else if (text) {
    try { reply = JSON.parse(text); } catch { reply = { error: { message: text.slice(0, 160) } }; }
  }
  return { status: res.status, reply, headers: res.headers };
}

/** tools/call → { result: parsed JSON of the text content, isError } */
async function callTool(accessToken, name, args) {
  const res = await mcp(accessToken, 'tools/call', { name, arguments: args });
  if (res.status !== 200 || !res.reply?.result) throw new Error(`${name}: HTTP ${res.status} ${JSON.stringify(res.reply).slice(0, 300)}`);
  const text = res.reply.result.content?.find((c) => c.type === 'text')?.text;
  let result = null;
  try { result = JSON.parse(text); } catch { result = { raw: text }; }
  return { result, isError: Boolean(res.reply.result.isError) };
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unescapeHtml = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const hiddenField = (html, name) => {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return match ? unescapeHtml(match[1]) : null;
};
/** "name=value; name2=value2" from a response's Set-Cookie headers (what a browser would send back). */
const cookiesOf = (headers) => headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !/=$/.test(c)).join('; ');

/** A fresh PKCE pair and the /authorize URL for the registered client. */
function authorizeUrl(clientId) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const stateParam = b64url(randomBytes(12));
  const query = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, code_challenge: challenge,
    code_challenge_method: 'S256', state: stateParam, resource: `${BASE}/mcp`,
  });
  return { path: `/authorize?${query}`, verifier, state: stateParam };
}

/** Signs in on the HTML page and taps Allow; returns the tokens (what Claude does when someone connects). */
async function connect(email, password, clientId = state.client.client_id) {
  const auth = authorizeUrl(clientId);
  const signIn = await postForm(auth.path, { step: 'signin', email, password });
  expect(signIn.status === 200, `sign-in page: HTTP ${signIn.status} ${signIn.html.match(/role="alert">([^<]*)/)?.[1] || ''}`);
  const handle = hiddenField(signIn.html, 'handle');
  expect(handle, 'the consent page carries a handle');
  const allow = await postForm(auth.path, { step: 'consent', handle, decision: 'allow' }, { cookie: cookiesOf(signIn.headers) });
  expect(allow.status === 302, `allow: HTTP ${allow.status}`);
  const back = new URL(allow.headers.get('location'));
  expect(back.searchParams.get('state') === auth.state, 'state comes back unchanged');
  const tokens = await tokenRequest({
    grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: REDIRECT_URI,
    client_id: clientId, code_verifier: auth.verifier, resource: `${BASE}/mcp`,
  });
  expect(tokens.status === 200 && tokens.data?.access_token, `token: HTTP ${tokens.status} ${JSON.stringify(tokens.data)}`);
  return tokens.data;
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

/* ---------- the run ---------- */
await step('Owner signs in to the back office', async () => {
  const status = await api('GET', '/api/auth/status', undefined, { auth: null });
  const res = status.data.has_users
    ? await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD }, { auth: null })
    : await api('POST', '/api/auth/bootstrap', { token: BOOTSTRAP_TOKEN, email: EMAIL, password: PASSWORD, name: 'Smoke Owner' }, { auth: null });
  expectStatus(res, 200, status.data.has_users ? 'login' : 'bootstrap');
  token = res.data.token;
  expect(res.data.user.role === 'owner', `expected an owner, got ${res.data.user.role}`);
});

await step('Discovery: /mcp answers 401 with a challenge that points at the metadata', async () => {
  const res = await mcp('', 'tools/list');
  expect(res.status === 401, `expected 401, got ${res.status}`);
  const challenge = res.headers.get('www-authenticate') || '';
  expect(challenge.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`), `challenge: ${challenge}`);
  const resource = await api('GET', '/.well-known/oauth-protected-resource/mcp', undefined, { auth: null });
  expectStatus(resource, 200, 'protected resource metadata');
  expect(resource.data.resource === `${BASE}/mcp` && resource.data.authorization_servers[0] === BASE, JSON.stringify(resource.data));
  const server = await api('GET', '/.well-known/oauth-authorization-server', undefined, { auth: null });
  expectStatus(server, 200, 'authorization server metadata');
  const m = server.data;
  expect(m.issuer === BASE && m.authorization_endpoint === `${BASE}/authorize` && m.token_endpoint === `${BASE}/token`
    && m.registration_endpoint === `${BASE}/register`, JSON.stringify(m));
  expect(m.code_challenge_methods_supported.includes('S256') && m.grant_types_supported.includes('refresh_token'), 'PKCE S256 and refresh tokens');
  const other = await fetch(`${BASE}/.well-known/not-oauth.txt`);
  expect(other.status === 404, `other /.well-known paths fall through to the static files (got ${other.status})`);
});

await step('The rest of the Worker is unchanged: static pages, video byte ranges, /loop, /api/*', async () => {
  for (const [path, type] of [['/', 'text/html'], ['/peachs.html', 'text/html'], ['/admin/', 'text/html'], ['/admin/admin.css', 'text/css']]) {
    const res = await fetch(`${BASE}${path}`);
    expect(res.status === 200 && (res.headers.get('content-type') || '').includes(type), `${path}: HTTP ${res.status} ${res.headers.get('content-type')}`);
    await res.arrayBuffer();
  }
  const range = await fetch(`${BASE}/signage/peachs-instore-loop.mp4`, { headers: { Range: 'bytes=0-1023' } });
  const body = await range.arrayBuffer();
  expect(range.status === 206 && /^bytes 0-1023\/\d+$/.test(range.headers.get('content-range') || '') && body.byteLength === 1024,
    `video range: HTTP ${range.status} ${range.headers.get('content-range')} ${body.byteLength} bytes`);
  const loop = await fetch(`${BASE}/loop`, { headers: { Range: 'bytes=0-15' } });
  await loop.arrayBuffer();
  expect([200, 206].includes(loop.status) && /attachment/.test(loop.headers.get('content-disposition') || ''), `/loop: HTTP ${loop.status} ${loop.headers.get('content-disposition')}`);
  const apiMissing = await api('GET', '/api/no-such-route', undefined, { auth: null });
  expect(apiMissing.status === 404 && apiMissing.data.code === 'not_found', 'unknown /api/* paths are still a JSON 404');
  const pub = await api('GET', `/api/public/${SLUG}`, undefined, { auth: null });
  expect(pub.status === 200 && pub.data.business?.slug === SLUG, `public bundle: HTTP ${pub.status}`);
});

await step('Dynamic client registration', async () => {
  const res = await api('POST', '/register', {
    client_name: 'Claude', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  }, { auth: null });
  expect(res.status === 201 || res.status === 200, `register: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  expect(res.data.client_id && !res.data.client_secret, 'a public client id without a secret');
  state.client = res.data;
  return res.data.client_id.slice(0, 8);
});

await step('Authorize: sign-in page in the admin look, refused for a bad client or a wrong password', async () => {
  const auth = authorizeUrl(state.client.client_id);
  const res = await fetch(`${BASE}${auth.path}`);
  const html = await res.text();
  expect(res.status === 200 && /Sign in to connect Claude/.test(html), `sign-in page: HTTP ${res.status}`);
  expect(html.includes('/admin/admin.css') && /<label class="field__label" for="password">/.test(html), 'admin stylesheet and labelled fields');
  const csp = res.headers.get('content-security-policy') || '';
  expect(csp.includes("frame-ancestors 'none'") && res.headers.get('cache-control') === 'no-store', `headers: ${csp}`);
  const badClient = await fetch(`${BASE}${auth.path.replace(state.client.client_id, 'no-such-client')}`, { redirect: 'manual' });
  expect(badClient.status === 400 && /This sign-in link does not work/.test(await badClient.text()), `an unknown client gets a local error page, not a redirect (got ${badClient.status})`);
  const badRedirect = await fetch(`${BASE}${auth.path.replace(encodeURIComponent(REDIRECT_URI), encodeURIComponent('https://evil.example/cb'))}`, { redirect: 'manual' });
  expect(badRedirect.status === 400, `an unregistered redirect URI is refused (got ${badRedirect.status})`);
  const wrong = await postForm(auth.path, { step: 'signin', email: EMAIL, password: 'not-the-password' });
  expect(wrong.status === 401 && /do not match/.test(wrong.html) && /aria-invalid="true"/.test(wrong.html), `wrong password: HTTP ${wrong.status}`);
  expect(!/name="handle"/.test(wrong.html), 'no consent page without the right password');
});

await step('Authorize: consent page, Allow only from the browser that signed in, then the code comes back', async () => {
  const auth = authorizeUrl(state.client.client_id);
  const signIn = await postForm(auth.path, { step: 'signin', email: EMAIL, password: PASSWORD });
  expect(signIn.status === 200, `sign-in: HTTP ${signIn.status}`);
  expect(/Allow Claude to manage every Rome’s Joy business as /.test(signIn.html), 'consent question names the businesses and the person');
  expect(/Access goes to <strong class="consent-host">claude\.ai<\/strong>/.test(signIn.html), 'consent page shows where access goes');
  const csp = signIn.headers.get('content-security-policy') || '';
  expect(csp.includes("form-action 'self' https://claude.ai"), `form-action allows the hop back to Claude: ${csp}`);
  const handle = hiddenField(signIn.html, 'handle');
  const cookie = cookiesOf(signIn.headers);
  expect(handle && /__Host-oauth-consent-/.test(cookie), 'handle and binding cookie');
  const noCookie = await postForm(auth.path, { step: 'consent', handle, decision: 'allow' });
  expect(noCookie.status === 400 && !noCookie.headers.get('location'), `Allow without the browser's cookie is refused (got ${noCookie.status})`);
  const allow = await postForm(auth.path, { step: 'consent', handle, decision: 'allow' }, { cookie });
  expect(allow.status === 302, `allow: HTTP ${allow.status} ${allow.html.slice(0, 200)}`);
  const back = new URL(allow.headers.get('location'));
  expect(`${back.origin}${back.pathname}` === REDIRECT_URI && back.searchParams.get('state') === auth.state, `redirect: ${back}`);
  expect(back.searchParams.get('code') && back.searchParams.get('iss') === BASE, 'code and issuer');
  const again = await postForm(auth.path, { step: 'consent', handle, decision: 'allow' }, { cookie });
  expect(again.status === 400, `the consent page works once (got ${again.status})`);
  state.pending = { code: back.searchParams.get('code'), verifier: auth.verifier };
});

await step('Token: PKCE code exchange; a replayed code is refused and revokes what it issued', async () => {
  const fields = {
    grant_type: 'authorization_code', code: state.pending.code, redirect_uri: REDIRECT_URI,
    client_id: state.client.client_id, resource: `${BASE}/mcp`,
  };
  const wrongVerifier = await tokenRequest({ ...fields, code_verifier: b64url(randomBytes(32)) });
  expect(wrongVerifier.status === 400, `a wrong code_verifier is refused (got ${wrongVerifier.status})`);
  const res = await tokenRequest({ ...fields, code_verifier: state.pending.verifier });
  if (res.status !== 200) {
    // Some servers burn a code after a failed PKCE check; fall back to a fresh sign-in so the rest can run.
    state.owner = await connect(EMAIL, PASSWORD);
    return 'the code was burned by the wrong verifier; connected again';
  }
  expect(res.data.access_token && res.data.refresh_token && /bearer/i.test(res.data.token_type), JSON.stringify(res.data));
  const first = await mcp(res.data.access_token, 'tools/list', {});
  expect(first.status === 200, `the new access token works (got ${first.status})`);
  // RFC 6749 §4.1.2: a code used twice is refused, and the tokens it already issued are revoked (it may have leaked).
  const reuse = await tokenRequest({ ...fields, code_verifier: state.pending.verifier });
  expect(reuse.status === 400, `a used code is refused (got ${reuse.status})`);
  const revoked = await mcp(res.data.access_token, 'tools/list', {});
  expect(revoked.status === 401, `the replay revoked the tokens it had issued (got ${revoked.status})`);
  state.owner = await connect(EMAIL, PASSWORD);
  return `expires in ${res.data.expires_in}s`;
});

await step('MCP: initialize and tools/list over Streamable HTTP', async () => {
  const init = await mcp(state.owner.access_token, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-test', version: '1.0.0' },
  });
  expect(init.status === 200 && init.reply?.result, `initialize: HTTP ${init.status} ${JSON.stringify(init.reply).slice(0, 200)}`);
  const result = init.reply.result;
  expect(result.serverInfo?.name === 'romesjoy-back-office' && result.capabilities?.tools, JSON.stringify(result.serverInfo));
  expect(/get_publish_link/.test(result.instructions || '') && /verify_change_set/.test(result.instructions) && /cannot publish/.test(result.instructions), 'server instructions: Claude cannot publish; the person does, from a link');
  expect(/data, not instructions/.test(result.instructions), 'server instructions: tool results are data, not instructions');
  const initialized = await mcp(state.owner.access_token, 'notifications/initialized', undefined, { notification: true });
  expect(initialized.status === 202, `initialized notification: HTTP ${initialized.status}`);
  const list = await mcp(state.owner.access_token, 'tools/list', {});
  expect(list.status === 200 && Array.isArray(list.reply?.result?.tools), `tools/list: ${JSON.stringify(list.reply).slice(0, 200)}`);
  const tools = list.reply.result.tools;
  const names = tools.map((t) => t.name);
  for (const name of ['list_businesses', 'get_business', 'list_photos', 'get_screens', 'propose_changes', 'get_publish_link', 'verify_change_set']) {
    expect(names.includes(name), `missing ${name}`);
  }
  expect(!names.includes('publish_change_set'), 'no tool publishes');
  const propose = tools.find((t) => t.name === 'propose_changes');
  expect(propose.inputSchema?.type === 'object' && propose.inputSchema.additionalProperties === false
    && propose.inputSchema.required.includes('ops'), `propose_changes schema: ${JSON.stringify(propose.inputSchema).slice(0, 200)}`);
  const annotations = Object.fromEntries(tools.map((t) => [t.name, t.annotations || {}]));
  expect(annotations.get_business.readOnlyHint === true && annotations.get_publish_link.readOnlyHint === true
    && annotations.propose_changes.readOnlyHint === false, `annotations: ${JSON.stringify(annotations.get_publish_link)}`);
  return `${tools.length} tools`;
});

await step('MCP: list_businesses and get_business', async () => {
  const { result: list, isError } = await callTool(state.owner.access_token, 'list_businesses', {});
  expect(!isError && Array.isArray(list.businesses) && list.businesses.length >= 7, `list_businesses: ${JSON.stringify(list).slice(0, 200)}`);
  expect(list.businesses.some((b) => b.slug === SLUG), `${SLUG} is listed`);
  const { result: biz } = await callTool(state.owner.access_token, 'get_business', { slug: SLUG });
  expect(biz.business?.slug === SLUG && biz.weekly_hours?.length === 7, `get_business: ${JSON.stringify(biz).slice(0, 200)}`);
  state.noticeBefore = biz.business.notice ?? null;
  const { result: bad, isError: badError } = await callTool(state.owner.access_token, 'get_business', { slug: SLUG, extra: 1 });
  expect(badError && bad, 'input that does not fit the schema comes back as a tool error');
  return `${list.businesses.length} businesses`;
});

await step('MCP: propose_changes drafts with absolute preview links; nothing is live yet', async () => {
  state.notice = `Connector test notice ${Date.now()}`;
  const { result, isError } = await callTool(state.owner.access_token, 'propose_changes', {
    title: 'Connector test: new notice', replace_change_set_id: null,
    ops: [{ op: 'business.patch', business_slug: SLUG, args_json: JSON.stringify({ notice: state.notice, notice_until: null }) }],
  });
  expect(!isError && result.change_set_id && result.status === 'draft', `propose: ${JSON.stringify(result).slice(0, 300)}`);
  expect(result.summary.some((s) => s.business_slug === SLUG) && result.checks.length, 'summary and checks');
  expect(result.preview_urls.length && result.preview_urls.every((p) => p.url.startsWith(`${BASE}/`)), `preview links: ${JSON.stringify(result.preview_urls)}`);
  state.changeSetId = result.change_set_id;
  const preview = await api('GET', `/api/public/${SLUG}?preview=${result.change_set_id}`, undefined, { auth: null });
  expect(preview.data.business?.notice === state.notice || JSON.stringify(preview.data).includes(state.notice), 'the preview shows the new notice');
  const live = await api('GET', `/api/public/${SLUG}`, undefined, { auth: null });
  expect(!JSON.stringify(live.data).includes(state.notice), 'the live site does not');
  return result.change_set_id.slice(0, 6);
});

await step('MCP: get_publish_link gives a back office link to the draft; nothing is published', async () => {
  const { result, isError } = await callTool(state.owner.access_token, 'get_publish_link', { id: state.changeSetId });
  expect(!isError && result.publish_url === `${BASE}/admin/#/draft/${state.changeSetId}` && result.status === 'draft', `link: ${JSON.stringify(result).slice(0, 300)}`);
  expect(/tap Publish/.test(result.next) && !/PUBLISH [A-Z0-9]{6}/.test(JSON.stringify(result)), 'it says the person publishes; no phrase to repeat');
  const { result: draft } = await callTool(state.owner.access_token, 'get_change_set', { id: state.changeSetId });
  expect(draft.status === 'draft', `still a draft: ${draft.status}`);
  const live = await api('GET', `/api/public/${SLUG}`, undefined, { auth: null });
  expect(!JSON.stringify(live.data).includes(state.notice), 'the live site does not show it');
  const old = await mcp(state.owner.access_token, 'tools/call', { name: 'publish_change_set', arguments: { id: state.changeSetId, confirm_phrase: `PUBLISH ${state.changeSetId.slice(0, 6).toUpperCase()}` } });
  expect(old.reply?.error || old.reply?.result?.isError, `there is no publishing tool to call: ${JSON.stringify(old.reply).slice(0, 200)}`);
});

await step('Back office: the person publishes the Claude app draft; verify says it is live; History says "Claude app"', async () => {
  const { change_set: seen } = (await api('GET', `/api/admin/change-sets/${state.changeSetId}`)).data;
  expect(seen.source === 'mcp' && seen.version, `draft as the back office shows it: ${JSON.stringify({ source: seen.source, version: seen.version })}`);
  const published = await api('POST', `/api/admin/change-sets/${state.changeSetId}/publish`, { version: seen.version });
  expectStatus(published, 200, 'Publish in the back office');
  const { result: link, isError: linkError } = await callTool(state.owner.access_token, 'get_publish_link', { id: state.changeSetId });
  expect(linkError && /already published/.test(link.error), `a link for a published draft says so: ${JSON.stringify(link)}`);
  const { result: verify } = await callTool(state.owner.access_token, 'verify_change_set', { id: state.changeSetId });
  expect(verify.ok === true && verify.lines.every((l) => l.ok), `verify: ${JSON.stringify(verify)}`);
  const live = await api('GET', `/api/public/${SLUG}`, undefined, { auth: null });
  expect(JSON.stringify(live.data).includes(state.notice), 'the live site shows the new notice');
  const history = await api('GET', `/api/admin/businesses/${SLUG}/history?limit=10`);
  expectStatus(history, 200, 'history');
  const entries = history.data.entries || history.data.history || [];
  expect(entries.some((e) => /^Claude app: /.test(e.summary)), `History entry prefixed "Claude app:": ${JSON.stringify(entries.slice(0, 3).map((e) => e.summary))}`);
});

await step('Refresh token: a new access token works', async () => {
  const res = await tokenRequest({ grant_type: 'refresh_token', refresh_token: state.owner.refresh_token, client_id: state.client.client_id });
  expect(res.status === 200 && res.data.access_token, `refresh: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  state.owner = { ...state.owner, ...res.data };
  const list = await mcp(state.owner.access_token, 'tools/list', {});
  expect(list.status === 200 && list.reply?.result?.tools?.length, 'tools/list with the refreshed token');
});

await step('Connected apps: listed for the owner, with where access goes', async () => {
  const res = await api('GET', '/api/admin/connected-apps');
  expectStatus(res, 200, 'list');
  const app = res.data.connected_apps.find((a) => a.name === 'Claude' && a.host === 'claude.ai');
  expect(app && app.id && app.connected_at && app.needs_sign_in === false, `apps: ${JSON.stringify(res.data.connected_apps)}`);
  state.appId = app.id;
  const unknown = await api('DELETE', '/api/admin/connected-apps/not-a-grant');
  expectStatus(unknown, 404, 'unknown id');
  const signedOut = await api('GET', '/api/admin/connected-apps', undefined, { auth: null });
  expectStatus(signedOut, 401, 'needs a session');
  return `${res.data.connected_apps.length} connected`;
});

await step('Connected apps: disconnecting stops the token and the refresh token at once', async () => {
  const res = await api('DELETE', `/api/admin/connected-apps/${encodeURIComponent(state.appId)}`);
  expectStatus(res, 200, 'revoke');
  const after = await mcp(state.owner.access_token, 'tools/list', {});
  expect(after.status === 401, `the access token stops working (got ${after.status})`);
  const refresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: state.owner.refresh_token, client_id: state.client.client_id });
  expect(refresh.status === 400, `the refresh token stops working (got ${refresh.status})`);
  const list = await api('GET', '/api/admin/connected-apps');
  expect(!list.data.connected_apps.some((a) => a.id === state.appId), 'no longer listed');
  const history = await api('GET', '/api/admin/history?limit=10');
  expect((history.data.entries || []).some((e) => /^Disconnected 'Claude'/.test(e.summary)), 'disconnect is in History');
});

await step('Cancel on the consent page sends the person back with access_denied; client names are escaped', async () => {
  const reg = await api('POST', '/register', {
    client_name: '<img src=x onerror=alert(1)>', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none',
  }, { auth: null });
  expect(reg.status === 201 || reg.status === 200, `register: HTTP ${reg.status}`);
  const auth = authorizeUrl(reg.data.client_id);
  const signIn = await postForm(auth.path, { step: 'signin', email: EMAIL, password: PASSWORD });
  expect(signIn.status === 200 && !signIn.html.includes('<img src=x') && signIn.html.includes('&lt;img src=x'), 'the name is escaped');
  const deny = await postForm(auth.path, { step: 'consent', handle: hiddenField(signIn.html, 'handle'), decision: 'deny' }, { cookie: cookiesOf(signIn.headers) });
  expect(deny.status === 302, `deny: HTTP ${deny.status}`);
  const back = new URL(deny.headers.get('location'));
  expect(back.searchParams.get('error') === 'access_denied' && back.searchParams.get('state') === auth.state && !back.searchParams.get('code'), `redirect: ${back}`);
});

await step('Authorize: a code only goes to Claude, and only with PKCE', async () => {
  const evil = await api('POST', '/register', { client_name: 'Claude', redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' }, { auth: null });
  expect(evil.status === 201 || evil.status === 200, `register: HTTP ${evil.status}`);
  const auth = authorizeUrl(evil.data.client_id);
  const page = await fetch(`${BASE}${auth.path.replace(encodeURIComponent(REDIRECT_URI), encodeURIComponent('https://evil.example/cb'))}`, { redirect: 'manual' });
  const html = await page.text();
  expect(page.status === 400 && /cannot connect to the back office/.test(html) && /evil\.example/.test(html) && !/name="password"/.test(html), `another site's address gets a warning, not a sign-in (got ${page.status})`);
  const posted = await postForm(auth.path.replace(encodeURIComponent(REDIRECT_URI), encodeURIComponent('https://evil.example/cb')), { step: 'signin', email: EMAIL, password: PASSWORD });
  expect(posted.status === 400 && !/name="handle"/.test(posted.html), `nor a consent page when posted to (got ${posted.status})`);
  // A client registered with a secret (the library only insists on PKCE for public ones).
  const secret = await api('POST', '/register', { client_name: 'Claude', redirect_uris: [REDIRECT_URI] }, { auth: null });
  expect(secret.data.client_secret, 'a client with a secret');
  const noPkce = new URLSearchParams({ response_type: 'code', client_id: secret.data.client_id, redirect_uri: REDIRECT_URI, state: 'no-pkce' });
  const refused = await fetch(`${BASE}/authorize?${noPkce}`, { redirect: 'manual' });
  const back = new URL(refused.headers.get('location') || 'http://none/');
  expect(refused.status === 302 && back.origin === 'https://claude.ai' && back.searchParams.get('error') === 'invalid_request' && back.searchParams.get('state') === 'no-pkce', `no PKCE → invalid_request (got ${refused.status} ${back})`);
});

await step('Registration: at most 20 an hour from one address', async () => {
  const ip = { 'CF-Connecting-IP': `203.0.113.${1 + Math.floor(Math.random() * 250)}` };
  const body = { client_name: 'Claude', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' };
  let last;
  for (let i = 0; i < 21; i++) last = await api('POST', '/register', body, { auth: null, headers: ip });
  expect(last.status === 429 && last.headers.get('retry-after') === '3600', `the 21st registration is refused (got ${last.status} ${JSON.stringify(last.data)})`);
  const login = await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD }, { auth: null, headers: ip });
  expectStatus(login, 200, 'registrations do not count as failed sign-ins');
});

await step('Sign-in lockouts are shared with /api/auth/login', async () => {
  const ip = { 'CF-Connecting-IP': `192.0.2.${1 + Math.floor(Math.random() * 250)}` }; // never FORM_IP's range, which later steps still use
  const auth = authorizeUrl(state.client.client_id);
  let last;
  for (let i = 0; i < 11; i++) last = await postForm(auth.path, { step: 'signin', email: `nobody-${Date.now()}@example.com`, password: 'wrong-password' }, { ip });
  expect(last.status === 429 && /Too many login attempts/.test(last.html), `the 11th try is locked out (got ${last.status})`);
  const login = await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD }, { auth: null, headers: ip });
  expect(login.status === 429, `the back office login from the same address is locked out too (got ${login.status})`);
});

await step('Editor: must choose a new password before connecting; then sees only their business', async () => {
  const created = await api('POST', '/api/admin/users', { email: EDITOR_EMAIL, name: 'Connector Editor', role: 'editor', businesses: [SLUG], password: EDITOR_PASSWORDS[0] });
  expect(created.status === 200 || created.status === 201, `create editor: HTTP ${created.status} ${JSON.stringify(created.data)}`);
  state.editorId = created.data.user.id;
  const auth = authorizeUrl(state.client.client_id);
  const early = await postForm(auth.path, { step: 'signin', email: EDITOR_EMAIL, password: EDITOR_PASSWORDS[0] });
  expect(early.status === 403 && /choose a new password/.test(early.html), `a new account is sent to the back office first (got ${early.status})`);
  const login = await api('POST', '/api/auth/login', { email: EDITOR_EMAIL, password: EDITOR_PASSWORDS[0] }, { auth: null, headers: FORM_IP });
  expectStatus(login, 200, 'editor login');
  const changed = await api('POST', '/api/auth/change-password', { current_password: EDITOR_PASSWORDS[0], new_password: EDITOR_PASSWORDS[1] }, { auth: login.data.token });
  expectStatus(changed, 200, 'editor sets a password');
  state.editorSession = login.data.token;
  const consent = await postForm(authorizeUrl(state.client.client_id).path, { step: 'signin', email: EDITOR_EMAIL, password: EDITOR_PASSWORDS[1] });
  expect(/Allow Claude to manage Peach/.test(consent.html), 'the consent page names their one business');
  state.editor = await connect(EDITOR_EMAIL, EDITOR_PASSWORDS[1]);
  const { result } = await callTool(state.editor.access_token, 'list_businesses', {});
  expect(result.businesses.length === 1 && result.businesses[0].slug === SLUG, `editor businesses: ${JSON.stringify(result.businesses.map((b) => b.slug))}`);
  const { result: other, isError } = await callTool(state.editor.access_token, 'propose_changes', {
    title: 'Not mine', replace_change_set_id: null,
    ops: [{ op: 'business.patch', business_slug: 'blanc', args_json: JSON.stringify({ notice: 'Not allowed' }) }],
  });
  expect(isError && other.error, `a business they cannot edit is refused: ${JSON.stringify(other).slice(0, 200)}`);
  const link = await callTool(state.editor.access_token, 'get_publish_link', { id: state.changeSetId });
  expect(link.isError, 'no link to someone else\'s change set');
});

await step('Editor: a password change ends the connection; connecting again works', async () => {
  const changed = await api('POST', '/api/auth/change-password', { current_password: EDITOR_PASSWORDS[1], new_password: EDITOR_PASSWORDS[2] }, { auth: state.editorSession });
  expectStatus(changed, 200, 'change password');
  const after = await mcp(state.editor.access_token, 'tools/list', {});
  expect(after.status === 401 && /invalid_token/.test(after.headers.get('www-authenticate') || ''), `old connection refused (got ${after.status})`);
  const apps = await api('GET', '/api/admin/connected-apps', undefined, { auth: state.editorSession });
  expect(apps.data.connected_apps.some((a) => a.needs_sign_in === true), `listed as needing sign-in: ${JSON.stringify(apps.data)}`);
  state.editor = await connect(EDITOR_EMAIL, EDITOR_PASSWORDS[2]);
  const list = await mcp(state.editor.access_token, 'tools/list', {});
  expect(list.status === 200, `new connection works (got ${list.status})`);
  const fresh = await api('GET', '/api/admin/connected-apps', undefined, { auth: state.editorSession });
  expect(fresh.data.connected_apps.length === 1 && fresh.data.connected_apps[0].needs_sign_in === false, `connecting again replaces the old one: ${JSON.stringify(fresh.data)}`);
});

await step('Editor: switched off → the connection and the sign-in page stop working at once', async () => {
  const off = await api('PATCH', `/api/admin/users/${state.editorId}`, { active: false });
  expectStatus(off, 200, 'deactivate');
  const after = await mcp(state.editor.access_token, 'tools/list', {});
  expect(after.status === 401, `deactivated user refused (got ${after.status})`);
  const signIn = await postForm(authorizeUrl(state.client.client_id).path, { step: 'signin', email: EDITOR_EMAIL, password: EDITOR_PASSWORDS[2] });
  expect(signIn.status === 401 && !/name="handle"/.test(signIn.html), `sign-in refused (got ${signIn.status})`);
  // Switched on again (seasonal staff, or a mistake): the old connection stays gone.
  expectStatus(await api('PATCH', `/api/admin/users/${state.editorId}`, { active: true }), 200, 'reactivate');
  const again = await mcp(state.editor.access_token, 'tools/list', {});
  expect(again.status === 401, `the old connection does not come back (got ${again.status})`);
  const refresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: state.editor.refresh_token, client_id: state.client.client_id });
  expect(refresh.status === 400, `nor does its refresh token (got ${refresh.status})`);
  const login = await api('POST', '/api/auth/login', { email: EDITOR_EMAIL, password: EDITOR_PASSWORDS[2] }, { auth: null, headers: FORM_IP });
  expectStatus(login, 200, 'editor signs in again');
  const apps = await api('GET', '/api/admin/connected-apps', undefined, { auth: login.data.token });
  expect(apps.data.connected_apps.length === 0, `no connected apps listed: ${JSON.stringify(apps.data)}`);
});

await step('Clean up: undo the published change and remove the test editor', async () => {
  const undo = await api('POST', `/api/admin/change-sets/${state.changeSetId}/undo`);
  expectStatus(undo, 200, 'undo');
  const live = await api('GET', `/api/public/${SLUG}`, undefined, { auth: null });
  expect(!JSON.stringify(live.data).includes(state.notice), 'the notice is gone again');
  const removed = await api('DELETE', `/api/admin/users/${state.editorId}`);
  expectStatus(removed, 200, 'remove editor');
});

/* ---------- summary ---------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.name).join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
