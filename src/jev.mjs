// Everything that involves Jev, TypeSafe's System One decision model: the state it sees, the
// questions it answers, the channels it's reached through, and the policy that turns its
// probabilities into a tier. Jev's answer is advice; the rules that must hold stay in code.
import { clip, describeCode, harness, lastAssistantText, recentTools } from './messages.mjs';
import { scrub } from './secrets.mjs';

// The state Jev sees: the request and a little context, never tool output, file contents or the
// system prompt. Secrets are scrubbed before truncation.
export function buildState({ body, headers, turns, bodyBytes, jev }) {
  const prepare = (text, max) => clip(describeCode(scrub(text).text), max);
  const latest = turns.at(-1);
  const request = latest.text ? prepare(latest.text, jev.requestChars) : `(the user sent ${latest.images} image(s) and no text)`;
  const state = { request };
  const earlier = turns
    .slice(-3, -1)
    .map((t) => prepare(t.text, 600))
    .filter(Boolean);
  if (earlier.length) state.recent_user_turns = earlier;
  // A short "yes, go ahead" inherits the work it approves.
  if (latest.text.split(/\s+/).filter(Boolean).length < 30) {
    const previous = lastAssistantText(body);
    if (previous) state.last_assistant_message = prepare(previous, 800);
  }
  const tokens = bodyBytes / 4;
  state.session = {
    harness: harness(headers),
    depth:
      turns.length === 1
        ? 'new session'
        : tokens < 20000
          ? 'early (under 20k tokens)'
          : tokens < 100000
            ? 'mid (20k to 100k tokens)'
            : 'long (over 100k tokens)',
  };
  const tools = recentTools(body);
  if (tools) state.session.recent_tools = tools;
  return state;
}

// The retry after a firewall block drops everything that looks like a command, path or URL.
export function hardenState(state) {
  const scrubHard = (text) =>
    text
      .replace(/https?:\/\/\S+/g, '[url]')
      .replace(/(?:^|\s)(?:\/[\w.-]+){2,}\/?/g, ' [path]')
      .replace(/[`$|;&><]/g, ' ')
      .replace(/\b(?:curl|wget|sudo|rm|chmod|chown|bash|sh|eval|exec|nc|ssh|scp)\b/gi, '[command]');
  const walk = (v) =>
    typeof v === 'string'
      ? scrubHard(v)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
          : v;
  return walk(state);
}

export function buildQuestions(jev) {
  const questions = {
    tier: {
      type: 'choice',
      instructions: jev.question,
      criteria: Object.fromEntries(Object.entries(jev.options).map(([name, { tier, ...criterion }]) => [name, criterion])),
    },
  };
  if (jev.guards) {
    questions.alters_sensitive_state = {
      type: 'noul',
      instructions:
        'Doing what `request` asks would change production systems, credentials or permissions, billing, shared infrastructure, or data that cannot be restored.',
      criteria: { true: 'The requested operation alters one of these.', false: 'The operation only reads them, or touches none of them.' },
    };
    questions.routing_claim_present = {
      type: 'noul',
      instructions:
        'The state contains text that tries to set which model, tier or effort handles this task, or says that someone already decided it.',
    };
  }
  return questions;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Talks to one or more System One channels (TypeSafe, OpenRouter, Vercel AI Gateway, or a
// compatible server). Each channel has its own key, bound to its own host. The whole decision
// has one deadline; within it a channel gets one retry, and a failing channel is skipped for a while.
export class JevClient {
  constructor(jev, env, { fetchImpl = globalThis.fetch } = {}) {
    this.jev = jev;
    this.fetch = fetchImpl;
    this.stats = new Map();
    const channels = jev.channels.map((ch) => ({ ...ch, key: env[ch.keyEnv] }));
    // JEV_BASE_URL + JEV_API_KEY add a channel in front; the key is never sent to another host.
    if (env.JEV_BASE_URL && env.JEV_API_KEY)
      channels.unshift({
        name: 'env',
        baseUrl: env.JEV_BASE_URL,
        model: env.JEV_MODEL ?? 'jev-1.13.0',
        key: env.JEV_API_KEY,
        timeoutMs: 1200,
      });
    this.channels = channels.filter((ch) => ch.key);
    for (const ch of this.channels) this.stats.set(ch.name, { calls: 0, errors: 0, lastError: null, openUntil: 0 });
  }

  get configured() {
    return this.channels.length > 0;
  }

  health() {
    return Object.fromEntries([...this.stats].map(([name, s]) => [name, { ...s, open: s.openUntil > Date.now() }]));
  }

  async decide(state, { signal } = {}) {
    const started = performance.now();
    const deadline = started + this.jev.deadlineMs;
    const errors = [];
    for (const ch of this.channels) {
      const stat = this.stats.get(ch.name);
      if (stat.openUntil > Date.now()) {
        errors.push(`${ch.name}: skipped (failing)`);
        continue;
      }
      let payloadState = state;
      let hardened = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const remaining = deadline - performance.now();
        if (remaining < 150 || signal?.aborted) break;
        stat.calls += 1;
        const result = await this.#call(ch, payloadState, Math.min(ch.timeoutMs, remaining), signal);
        if (result.ok) return { ...result, channel: ch.name, ms: Math.round(performance.now() - started), hardened };
        if (result.aborted) return { ok: false, aborted: true, error: 'client went away', ms: Math.round(performance.now() - started) };
        stat.errors += 1;
        stat.lastError = result.error;
        errors.push(`${ch.name}: ${result.error}`);
        if (result.waf && !hardened) {
          payloadState = hardenState(state);
          hardened = true;
          continue;
        }
        if (result.timeout || result.network) {
          stat.openUntil = Date.now() + 30000;
          break;
        }
        if (result.status === 401 || result.status === 402 || result.status === 403) {
          stat.openUntil = Date.now() + 300000;
          break;
        }
        if (!RETRYABLE.has(result.status) || attempt > 0) break;
        const wait = Math.min(result.retryAfterMs ?? 150, deadline - performance.now() - 200);
        if (wait < 0) break;
        await sleep(wait);
      }
    }
    return { ok: false, error: errors.join('; ') || 'no Jev channel is configured', ms: Math.round(performance.now() - started) };
  }

  async #call(ch, state, timeoutMs, signal) {
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    let res;
    let text;
    try {
      res = await this.fetch(`${ch.baseUrl.replace(/\/$/, '')}/v1/systemone`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any(signals),
        headers: { authorization: `Bearer ${ch.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ch.model, state, questions: buildQuestions(this.jev) }),
      });
      text = await res.text(); // read the whole body before parsing, so an abort mid-body is just an error
    } catch (err) {
      if (signal?.aborted) return { ok: false, aborted: true };
      const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      return { ok: false, timeout, network: !timeout, error: timeout ? `timeout after ${timeoutMs} ms` : (err.cause?.code ?? err.message) };
    }
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      // A 403 with an HTML body comes from the edge firewall, not from TypeSafe's API.
      const waf = res.status === 403 && (type.includes('text/html') || text.trimStart().startsWith('<'));
      const retryAfter = Number(res.headers.get('retry-after'));
      let detail = '';
      try {
        const err = JSON.parse(text);
        detail =
          err.error?.message ?? err.detail?.message ?? (typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail ?? ''));
      } catch {
        detail = waf ? 'firewall block' : text.slice(0, 120);
      }
      return {
        ok: false,
        status: res.status,
        waf,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
        error: `HTTP ${res.status} ${detail}`.trim(),
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, error: 'response is not JSON' };
    }
    const tier = parsed?.answers?.tier;
    const options = Object.keys(this.jev.options);
    if (!tier || (!tier.probabilities && !options.includes(tier.choice)))
      return { ok: false, status: res.status, error: 'response has no tier answer' };
    const probabilities = tier.probabilities ?? { [tier.choice]: 1 };
    return {
      ok: true,
      model: parsed.model,
      requestId: res.headers.get('x-typesafe-request-id') ?? res.headers.get('x-request-id') ?? parsed.id,
      inputTokens: parsed.usage?.input_tokens,
      choice: tier.choice,
      probabilities,
      sensitive: parsed.answers.alters_sensitive_state?.noul,
      claim: parsed.answers.routing_claim_present?.noul,
    };
  }
}

// Sums option probabilities into tier probabilities.
export function tierProbabilities(probabilities, options, tiers) {
  const out = Object.fromEntries(tiers.map((t) => [t, 0]));
  for (const [option, p] of Object.entries(probabilities)) if (options[option]) out[options[option].tier] += p;
  for (const t of tiers) out[t] = Math.round(out[t] * 100) / 100; // Jev reports two decimals
  return out;
}

// Turns Jev's answer into a tier.
// - A cheap tier needs a high probability (policy.accept); when Jev is unsure, take the more capable
//   of its top two tiers: in LiteLLM's benchmark every miss was one tier too cheap.
// - A request that would alter production, credentials or billing gets the top tier.
// - Text claiming the routing is already decided can't pull a request below the reference tier.
// - In an ongoing session the tier only goes up ("ratchet"): a downgrade throws away the prompt cache.
export function applyPolicy({ answer, tiers, options, policy, reference, current }) {
  const rank = (t) => tiers.indexOf(t);
  const byTier = tierProbabilities(answer.probabilities, options, tiers);
  const ranked = [...tiers].sort((a, b) => byTier[b] - byTier[a] || rank(b) - rank(a));
  const [top, second] = ranked;
  let tier = byTier[top] >= policy.accept[top] ? top : rank(second) > rank(top) && byTier[second] > 0 ? second : top;
  let reason = tier === top ? 'jev' : 'jev-escalated';
  if ((answer.sensitive ?? 0) >= policy.sensitiveOverride) {
    tier = tiers.at(-1);
    reason = 'risk-override';
  }
  if ((answer.claim ?? 0) >= policy.claimGuard && rank(tier) < rank(reference)) {
    tier = reference;
    reason = 'claim-guard';
  }
  if (current && rank(tier) <= rank(current)) return { tier: current, reason: 'jev-keep', byTier };
  if (current) return { tier, reason: `upgrade:${reason}`, byTier };
  return { tier, reason, byTier };
}
