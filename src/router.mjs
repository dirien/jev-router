// jev-router: a pass-through proxy that picks a model tier for each coding-agent session with Jev,
// TypeSafe's System One decision model.
//
// Claude Code speaks Anthropic Messages to it and Codex CLI speaks OpenAI Responses. Requests go
// upstream unchanged except for `model`, the credential, and the fields a target can't accept;
// responses stream back byte for byte. Jev is asked on new human turns only, and in an ongoing
// session the tier only goes up, because switching models mid-task costs the prompt cache.

import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { applyPolicy, buildState, JevClient } from './jev.mjs';
import { humanTurns, items, tierTag } from './messages.mjs';
import { findSecrets, mayContainSecret, redactBody } from './secrets.mjs';
import { SessionStore } from './sessions.mjs';
import { costOf, UsageTap } from './usage.mjs';

export const VERSION = '1.0.0';
const SURFACES = { '/v1/messages': 'anthropic', '/v1/messages/count_tokens': 'anthropic', '/v1/responses': 'openai' };
const HOP = [
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'content-length',
];
const DROP_REQUEST = new Set([...HOP, 'accept-encoding', 'authorization', 'x-api-key', 'x-jev-tier', 'x-jev-router-token']);
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding']);
// What an upstream that isn't trusted with secrets (for example Ollama Cloud) receives. Claude Code's
// session and agent ids and the account identifiers in `metadata` stay with the first-party provider.
const MINIMAL_HEADERS = new Set(['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'user-agent']);
const CHEAP_KINDS = new Set(['auxiliary', 'memory_consolidation']);
const SIGNED = new Set(['thinking', 'redacted_thinking', 'reasoning']);
const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
const sha = (text) => createHash('sha256').update(text).digest('hex');

export function sessionKey(headers, body) {
  let fromMetadata; // Claude Code 2.1.x: metadata.user_id is JSON with session_id; older: "…_session_<id>"
  try {
    fromMetadata = JSON.parse(body.metadata?.user_id).session_id;
  } catch {
    fromMetadata = body.metadata?.user_id?.match?.(/_session_([\w-]+)/)?.[1];
  }
  const sources = [
    ['claude-code-header', headers['x-claude-code-session-id']],
    ['claude-code-metadata', fromMetadata],
    ['codex-session', headers['session-id']],
    ['codex-thread', headers['thread-id']],
    ['prompt-cache-key', body.prompt_cache_key],
  ];
  for (const [source, id] of sources) if (typeof id === 'string' && id) return { id, source };
  // No client id: the system prompt and the first messages stay the same for a whole conversation.
  return { id: `h:${sha(JSON.stringify([body.system ?? body.instructions ?? null, items(body).slice(0, 2)]))}`, source: 'hash' };
}

// main | subagent | compaction | auxiliary | workflow, from Claude Code's hint headers and Codex's labels.
export function requestKind(headers) {
  const cc = headers['x-claude-code-request-class'];
  if (cc) return cc;
  const codex = headers['x-openai-subagent'];
  if (codex) return codex === 'compact' ? 'compaction' : codex === 'memory_consolidation' ? 'auxiliary' : 'subagent';
  if (headers['x-claude-code-agent-id']) return 'subagent';
  return undefined;
}

export function createRouter(
  input,
  { env = process.env, log = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`), fetchImpl = globalThis.fetch, store } = {},
) {
  let cfg = input;
  let jev = new JevClient(cfg.jev, env, { fetchImpl });
  // Defined before the session store: it loads the state file, and reports errors, while it is constructed.
  const warned = new Set();
  const warn = (message) => {
    if (!warned.has(message)) {
      warned.add(message);
      log({ ts: new Date().toISOString(), event: 'warning', message });
    }
  };
  const sessions =
    store ?? new SessionStore({ file: cfg.stateFile, max: cfg.maxSessions, onError: (err) => warn(`session file: ${err.message}`) });
  const inflight = new Map();
  const started = Date.now();
  let active = 0;
  const token = env.JEV_ROUTER_TOKEN ?? cfg.token;
  const allowedHosts = () => {
    const port = server.address()?.port ?? cfg.port;
    return new Set([...['127.0.0.1', 'localhost', '[::1]'].map((h) => `${h}:${port}`), ...cfg.allowedHosts]);
  };

  // Decides the tier for one request. Returns { key, tier, reason, trustedOnly, jev?, remember? }.
  async function decide({ headers, body, raw, countOnly, signal }) {
    const key = sessionKey(headers, body);
    const entry = sessions.get(key.id);
    const kind = requestKind(headers);
    const { tiers, defaultTier, policy } = cfg;
    const turns = humanTurns(body);
    const latest = turns.at(-1);
    const base = { key, kind, turnCount: turns.length, latestIndex: latest?.index, latestText: latest?.text };
    // Deterministic secret scan of what the human just wrote. A hit keeps the whole session on
    // trusted upstreams, whatever tags, pins or Jev say.
    const secrets = latest ? findSecrets(latest.text) : [];
    const trustedOnly = Boolean(entry?.trustedOnly || secrets.length);
    const follow = (reason) => ({ ...base, tier: entry?.tier ?? defaultTier, reason, trustedOnly });
    const remember = (tier, reason, extra = {}) => ({
      ...base,
      tier,
      reason,
      trustedOnly,
      remember: { tier, trustedOnly, provisional: false, attempts: 0, freshNext: false, ...extra },
    });

    if (countOnly) return follow('count-tokens');
    const main = kind === undefined || kind === 'main';
    // Background calls: Claude Code's small-model requests (titles, topic checks) and quota probes.
    // With hint headers the request class decides; the model-name rule applies only without them.
    if (
      CHEAP_KINDS.has(kind) ||
      body.max_tokens <= 1 ||
      (kind === undefined && new RegExp(cfg.sideCallModel, 'i').test(body.model ?? ''))
    ) {
      return { ...base, tier: 'side', reason: 'side-call', trustedOnly };
    }
    if (!main) return follow(kind); // subagents, compaction and workflows run on the session's tier
    if (kind === undefined && headers['user-agent']?.startsWith('claude-cli'))
      warn('Claude Code requests carry no request class. Set CLAUDE_CODE_GATEWAY_HINT_HEADERS=1 so background calls are recognized.');

    const pin = headers['x-jev-tier'] ?? env.JEV_ROUTER_TIER;
    if (pin && !tiers.includes(pin)) warn(`Ignoring unknown tier pin "${pin}". Known tiers: ${tiers.join(', ')}.`);
    if (pin && tiers.includes(pin)) return remember(pin, 'pinned', { pinned: true, clientModel: entry?.clientModel ?? body.model });

    // /model in Claude Code changes the requested model; follow the user's explicit switch.
    const family = MODEL_FAMILIES.find((f) => body.model?.includes(f));
    const previousFamily = MODEL_FAMILIES.find((f) => entry?.clientModel?.includes(f));
    const familyTier = cfg.modelPins?.[family];
    if (cfg.pinOnModelChange && entry && family && previousFamily && family !== previousFamily && tiers.includes(familyTier)) {
      return remember(familyTier, `client-model:${family}`, { clientModel: body.model, turns: turns.length });
    }

    const newTurn = latest && (!entry || turns.length > (entry.turns ?? 0));
    const shrank = entry && turns.length < (entry.turns ?? 0); // compaction or a fork: the cache is cold anyway
    const tag = newTurn && latest.text ? tierTag(latest.text, tiers) : undefined;
    if (tag) return remember(tag, 'tag', { clientModel: entry?.clientModel ?? body.model, turns: turns.length });
    if (!newTurn) {
      if (entry)
        return {
          ...follow(shrank ? 'sticky:history-shrank' : 'sticky'),
          remember: shrank ? { ...entry, turns: turns.length, freshNext: true } : undefined,
        };
      // Unknown session in the middle of a tool loop (a restart without a state file): hold the
      // default tier without pinning, and let the next human turn decide.
      return { ...remember(defaultTier, 'no-prompt', { provisional: true, turns: turns.length }) };
    }

    const idle = entry && Date.now() - (entry.lastSeen ?? entry.updated ?? 0) > policy.idleResetMinutes * 60000;
    const fresh = !entry || entry.provisional || entry.freshNext || idle;
    if (entry && !fresh && policy.mode === 'sticky') return follow('sticky');
    if (!jev.configured) {
      warn('No Jev channel has a key, so every session uses the default tier. Set TYPESAFE_API_KEY or OPENROUTER_API_KEY.');
      return entry ? follow('no-jev') : remember(defaultTier, 'no-jev', { turns: turns.length, clientModel: body.model });
    }

    // One Jev call per human turn, shared by concurrent requests of that turn.
    const flightKey = `${key.id}#${turns.length}`;
    let flight = inflight.get(flightKey);
    if (!flight) {
      const state = buildState({ body, headers, turns, bodyBytes: raw.length, jev: cfg.jev });
      flight = jev.decide(state, { signal }).finally(() => inflight.delete(flightKey));
      inflight.set(flightKey, flight);
    }
    const answer = await flight;
    const clientModel = entry?.clientModel ?? body.model;
    if (!answer.ok) {
      const jevInfo = { ok: false, ms: answer.ms, error: answer.error };
      if (answer.aborted) return { ...follow('client-aborted'), jev: jevInfo };
      if (entry && !entry.provisional) return { ...follow('fallback:keep'), jev: jevInfo, remember: { ...entry, turns: turns.length } };
      const attempts = (entry?.attempts ?? 0) + 1;
      const provisional = attempts < policy.maxProvisional;
      return {
        ...remember(entry?.tier ?? defaultTier, 'fallback:default', {
          provisional,
          attempts,
          turns: turns.length,
          clientModel,
          trustedOnly: trustedOnly || (policy.failClosed && provisional),
        }),
        trustedOnly: trustedOnly || (policy.failClosed && provisional),
        jev: jevInfo,
      };
    }
    const decision = applyPolicy({
      answer,
      tiers,
      options: cfg.jev.options,
      policy,
      reference: fresh ? defaultTier : entry.tier,
      current: fresh ? undefined : entry.tier,
    });
    const jevInfo = {
      ok: true,
      channel: answer.channel,
      model: answer.model,
      requestId: answer.requestId,
      ms: answer.ms,
      inputTokens: answer.inputTokens,
      choice: answer.choice,
      probabilities: answer.probabilities,
      tiers: decision.byTier,
      sensitive: answer.sensitive,
      claim: answer.claim,
      hardened: answer.hardened || undefined,
    };
    return {
      ...remember(decision.tier, decision.reason, { turns: turns.length, clientModel }),
      jev: jevInfo,
      secrets: secrets.length || undefined,
    };
  }

  async function handle(req, res, signal) {
    const startedAt = performance.now();
    const path = req.url.split('?')[0];
    const surface = SURFACES[path];
    if (req.method !== 'POST' || !surface) return fail(res, 404, `No route for ${req.method} ${path}`);
    if (!cfg.surfaces[surface]) return fail(res, 404, `No route for ${path}: the config has no ${surface} surface`, surface);
    if (!(req.headers['content-type'] ?? '').includes('application/json'))
      return fail(res, 415, 'Content-Type must be application/json', surface);
    if (token && !safeEqual(req.headers['x-jev-router-token'] ?? '', token))
      return fail(res, 401, 'Missing or wrong x-jev-router-token header', surface);
    const raw = await readBody(req, cfg.maxBodyBytes);
    if (raw === null) return fail(res, 413, `Request body exceeds ${cfg.maxBodyBytes} bytes`, surface);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(res, 400, 'Request body is not JSON', surface);
    }
    if (body?.constructor !== Object) return fail(res, 400, 'Request body must be a JSON object', surface);

    const countOnly = path.endsWith('/count_tokens');
    const decision = await decide({ headers: req.headers, body, raw, countOnly, signal });
    const targets = cfg.surfaces[surface];
    const chosen = targets[decision.tier] ?? targets[cfg.tiers[0]];
    const target = decision.trustedOnly && !chosen.trusted ? targets.trusted : chosen;
    const host = new URL(target.url).host;
    const session = createHash('sha256').update(decision.key.id).digest('hex').slice(0, 12);
    const main = decision.kind === undefined || decision.kind === 'main';

    // Remember the decision, and where the current provider took over the session: signed reasoning
    // from before that point came from another provider and must not be sent back to this one.
    const stored = sessions.get(decision.key.id);
    let entry = decision.remember ? { ...stored, ...decision.remember } : stored;
    let changed = Boolean(decision.remember);
    if (main && !countOnly && decision.tier !== 'side' && entry?.lastHost && entry.lastHost !== host && decision.latestText !== undefined) {
      const anchor = sha(decision.latestText).slice(0, 16);
      if (entry.anchor !== anchor) {
        entry = { ...entry, anchor };
        changed = true;
      }
    }
    if (entry && changed) entry = sessions.set(decision.key.id, entry);
    sessions.touch(decision.key.id);

    const shown = { 'x-jev-tier': decision.tier, 'x-jev-model': target.model, 'x-jev-reason': decision.reason, 'x-jev-session': session };
    const entryLog = (event, fields) => log({ ts: new Date().toISOString(), event, session, ...fields });
    entryLog('route', {
      path,
      kind: decision.kind,
      key_source: decision.key.source,
      tier: decision.tier,
      reason: decision.reason,
      model: target.model,
      upstream: host,
      trusted_only: decision.trustedOnly || undefined,
      secrets: decision.secrets,
      jev: decision.jev,
    });
    // Never count a prompt with another provider's tokenizer; Claude Code estimates on a 404.
    if (countOnly && target.countTokens === false) return fail(res, 404, `${target.model} has no count_tokens endpoint`, surface, shown);
    if (signal.aborted) return entryLog('done', { status: 499, client_aborted: true, ms: Math.round(performance.now() - startedAt) });

    let outgoing = body;
    if (entry?.anchor && !countOnly && main) outgoing = stripForeignReasoning(outgoing, entry.anchor);
    let redacted = 0;
    if (!target.trusted && mayContainSecret(raw)) ({ body: outgoing, count: redacted } = redactBody(outgoing));
    if (redacted) shown['x-jev-redacted'] = String(redacted);
    outgoing = omitFields({ ...outgoing, model: target.model }, target.omit);
    if (!target.trusted) delete outgoing.metadata;

    try {
      const result = await forward(req, res, target, outgoing, shown, signal, env);
      const cost = costOf(target.model, result.usage, cfg.prices);
      const baselineModel = cfg.baselineModel?.[surface];
      entryLog('done', {
        status: result.status,
        model: target.model,
        ms: Math.round(performance.now() - startedAt),
        bytes: result.bytes,
        sha256: result.sha256,
        redacted: redacted || undefined,
        client_aborted: result.aborted || undefined,
        usage: result.usage,
        cost_usd: cost,
        baseline_usd: baselineModel ? costOf(baselineModel, result.usage, cfg.prices) : undefined,
      });
      if (main && result.status < 300 && decision.tier !== 'side' && !countOnly && entry && entry.lastHost !== host)
        sessions.set(decision.key.id, { ...entry, lastHost: host });
    } catch (err) {
      entryLog('error', { error: err.message });
      if (!res.headersSent) fail(res, 502, `Upstream request failed: ${err.message}`, surface, shown);
      else res.destroy();
    }
  }

  const server = http.createServer((req, res) => {
    // Requests from a browser tab (cross-site or DNS rebinding) must not spend your keys.
    if (!allowedHosts().has(req.headers.host)) return fail(res, 403, `Host "${req.headers.host}" is not allowed`);
    if (req.headers.origin && !(cfg.allowedOrigins ?? []).includes(req.headers.origin))
      return fail(res, 403, 'Cross-origin requests are not allowed');
    if (req.method === 'GET' && req.url === '/healthz') return health(res);
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    active += 1;
    handle(req, res, controller.signal)
      .catch((err) => {
        // one malformed request must not take the router down
        log({ ts: new Date().toISOString(), event: 'error', path: req.url, error: err.message });
        if (!res.headersSent) fail(res, 500, 'The router could not handle this request', SURFACES[req.url.split('?')[0]]);
        else res.destroy();
      })
      .finally(() => {
        active -= 1;
      });
  });

  function health(res) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        version: VERSION,
        uptime_s: Math.round((Date.now() - started) / 1000),
        sessions: sessions.size,
        active,
        jev: { configured: jev.configured, channels: jev.health() },
      }),
    );
  }

  // Not Object.assign: it would read the `active` getter once and copy a 0 that never changes.
  Object.defineProperties(
    server,
    Object.getOwnPropertyDescriptors({
      sessions,
      get active() {
        return active;
      },
      reload(next) {
        cfg = next;
        jev = new JevClient(cfg.jev, env, { fetchImpl });
      },
    }),
  );
  return server;
}

// Drops signed reasoning (thinking blocks, encrypted reasoning items) that came before the human turn
// where the current provider took over. Another provider's signatures are always rejected.
function stripForeignReasoning(body, anchor) {
  const list = items(body);
  const turns = humanTurns(body);
  const at = turns.find((t) => sha(t.text).slice(0, 16) === anchor)?.index;
  if (at === undefined) return body; // compacted or a different conversation: nothing foreign left in it
  if (Array.isArray(body.input)) return { ...body, input: body.input.filter((item, i) => i >= at || !SIGNED.has(item?.type)) };
  return {
    ...body,
    messages: list.map((m, i) =>
      i >= at || m?.role !== 'assistant' || !Array.isArray(m.content)
        ? m
        : { ...m, content: m.content.filter((b) => !SIGNED.has(b?.type)) },
    ),
  };
}

// Removes fields a target rejects. Paths may be nested: "output_config.effort".
function omitFields(body, paths = []) {
  if (!paths.length) return body;
  const out = structuredClone(body);
  for (const path of paths) {
    const keys = path.split('.');
    const parent = keys.slice(0, -1).reduce((node, k) => (node && typeof node === 'object' ? node[k] : undefined), out);
    if (parent && typeof parent === 'object') delete parent[keys.at(-1)];
  }
  return out;
}

async function forward(req, res, target, body, shown, signal, env) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (DROP_REQUEST.has(name)) continue;
    if (!target.trusted && !MINIMAL_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  headers['accept-encoding'] = 'identity'; // relay upstream bytes as they are
  const key = target.keyEnv ? env[target.keyEnv] : undefined;
  if (key && target.auth === 'bearer') headers.authorization = `Bearer ${key}`;
  else if (key) headers['x-api-key'] = key;
  else if (target.clientAuth) {
    // no router key: pass the client's own login (for example claude.ai) to its provider only
    for (const name of ['authorization', 'x-api-key']) if (req.headers[name]) headers[name] = req.headers[name];
  }
  const upstream = await fetch(target.url + req.url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
  res.writeHead(upstream.status, { ...Object.fromEntries([...upstream.headers].filter(([n]) => !DROP_RESPONSE.has(n))), ...shown });
  const hash = createHash('sha256');
  const tap = new UsageTap(upstream.headers.get('content-type') ?? '');
  let bytes = 0;
  try {
    for await (const chunk of upstream.body ?? []) {
      hash.update(chunk);
      tap.push(chunk);
      bytes += chunk.length;
      if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
      if (res.destroyed) break;
    }
  } catch (err) {
    if (!signal.aborted) throw err;
  }
  res.end();
  return { status: upstream.status, bytes, sha256: hash.digest('hex'), usage: tap.result(), aborted: signal.aborted };
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  let over = false;
  for await (const chunk of req) {
    // keep reading past the limit, so the 413 can still be sent
    size += chunk.length;
    if (size > limit) {
      over = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  return over ? null : Buffer.concat(chunks);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Errors the router raises itself, in the error shape of the client's own provider.
function fail(res, status, message, surface, headers = {}) {
  const type =
    {
      400: 'invalid_request_error',
      401: 'authentication_error',
      403: 'permission_error',
      404: 'not_found_error',
      413: 'request_too_large',
      415: 'invalid_request_error',
    }[status] ?? 'api_error';
  const body = surface === 'openai' ? { error: { message, type, param: null, code: null } } : { type: 'error', error: { type, message } };
  res.writeHead(status, { 'content-type': 'application/json', ...(status < 500 ? { 'x-should-retry': 'false' } : {}), ...headers });
  res.end(JSON.stringify(body));
}

// `node router.mjs report [log.jsonl]`: requests, spend, savings against the baseline, and Jev health.
export function report(lines) {
  const models = new Map();
  const jevMs = [];
  const sessions = new Set();
  let requests = 0;
  let jevCalls = 0;
  let fallbacks = 0;
  let jevInput = 0;
  let cost = 0;
  let baseline = 0;
  let unpriced = 0;
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object') continue; // a stray `null` line must not abort the report
    if (e.event === 'route') {
      requests += 1;
      sessions.add(e.session);
      if (e.jev) {
        jevCalls += 1;
        if (e.jev.ok) {
          jevMs.push(e.jev.ms);
          jevInput += e.jev.inputTokens ?? 0;
        } else fallbacks += 1;
      }
    } else if (e.event === 'done' && e.model) {
      const m = models.get(e.model) ?? { requests: 0, cost_usd: 0, input: 0, cache_read: 0, output: 0 };
      m.requests += 1;
      if (e.usage) {
        m.input += e.usage.input;
        m.cache_read += e.usage.cacheRead;
        m.output += e.usage.output;
      }
      if (e.cost_usd === undefined) {
        if (e.usage) unpriced += 1;
      } else {
        m.cost_usd += e.cost_usd;
        cost += e.cost_usd;
      }
      baseline += e.baseline_usd ?? e.cost_usd ?? 0;
      models.set(e.model, m);
    }
  }
  jevMs.sort((a, b) => a - b);
  const pct = (p) => (jevMs.length ? jevMs[Math.min(jevMs.length - 1, Math.floor(p * jevMs.length))] : null);
  const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
  return {
    requests,
    sessions: sessions.size,
    models: Object.fromEntries([...models].map(([m, v]) => [m, { ...v, cost_usd: round(v.cost_usd) }])),
    cost_usd: round(cost),
    baseline_usd: round(baseline),
    saved_usd: round(baseline - cost),
    unpriced_responses: unpriced,
    jev: {
      calls: jevCalls,
      fallbacks,
      fallback_rate: jevCalls ? round(fallbacks / jevCalls, 3) : 0,
      p50_ms: pct(0.5),
      p95_ms: pct(0.95),
      cost_usd: round(jevInput * 0.042e-6, 6),
    },
  };
}
