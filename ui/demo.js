// A scripted demo for `/?demo`: a looping, realistic run that emits the same events the router
// logs, so the page can be tried and screenshotted without a router or any keys.

/** @typedef {Record<string, unknown>} LogEvent */
/** @typedef {(event: LogEvent) => void} Emit */
/** @typedef {{ model: string, upstream: string, trusted: boolean }} Target */
/** @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number }} Usage */
/** @typedef {{ at: number, make: () => LogEvent }} Beat */

const LOOP_MS = 60_000;
const ANTHROPIC = 'api.anthropic.com';
const BASELINE = 'claude-opus-5-5';

/** USD per million tokens: input, output, cache read, cache write. */
/** @type {Record<string, [number, number, number, number]>} */
const PRICES = {
  'claude-haiku-4-5': [1, 5, 0.1, 1.25],
  'claude-sonnet-5': [2, 10, 0.2, 2.5],
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-fable-5-1': [10, 50, 0.25, 12.5],
  'kimi-k2.7-code': [0.95, 4, 0.19, 0.95],
  'glm-5.3-flash': [0.15, 0.5, 0.03, 0.15],
};

/** @type {Record<string, string>} */
const OPTIONS = { mechanical: 'fast', routine: 'balanced', complex: 'frontier', deep: 'max' };

/**
 * @param {string} model
 * @param {string} upstream
 * @param {boolean} trusted
 * @returns {Target}
 */
const target = (model, upstream, trusted) => ({ model, upstream, trusted });

/** @type {Record<string, Record<string, Target>>} */
const SURFACES = {
  anthropic: {
    side: target('claude-haiku-4-5', ANTHROPIC, true),
    fast: target('claude-haiku-4-5', ANTHROPIC, true),
    balanced: target('claude-sonnet-5', ANTHROPIC, true),
    frontier: target('claude-opus-5-5', ANTHROPIC, true),
    max: target('claude-fable-5-1', ANTHROPIC, true),
    trusted: target('claude-sonnet-5', ANTHROPIC, true),
  },
  openai: {
    fast: target('glm-5.3-flash', 'ollama.com', false),
    balanced: target('kimi-k2.7-code', 'ollama.com', false),
    frontier: target('gpt-6-astra', 'api.openai.com', true),
    max: target('gpt-6-astra', 'api.openai.com', true),
    trusted: target('gpt-6-sol', 'api.openai.com', true),
  },
};

/** @returns {LogEvent} */
function configEvent() {
  return {
    event: 'config',
    mode: 'ratchet',
    tiers: ['fast', 'balanced', 'frontier', 'max'],
    defaultTier: 'balanced',
    options: OPTIONS,
    accept: { fast: 0.85, balanced: 0.6, frontier: 0.3, max: 0.3 },
    sensitiveOverride: 0.7,
    claimGuard: 0.5,
    surfaces: SURFACES,
    jev: {
      channels: [
        { name: 'typesafe', model: 'jev-1.13.0', host: 'api.typesafe.ai' },
        { name: 'openrouter', model: 'typesafe/jev-1.13', host: 'openrouter.ai' },
      ],
    },
  };
}

/** @param {number} bytes */
const hex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * @param {string} model
 * @param {Usage} usage
 */
function cost(model, usage) {
  const price = PRICES[model];
  if (!price) return undefined;
  const [input, output, read, write] = price;
  return Math.round(((usage.input * input + usage.output * output + usage.cacheRead * read + usage.cacheWrite * write) / 1e6) * 1e6) / 1e6;
}

/** @param {Record<string, number>} probabilities */
function byTier(probabilities) {
  /** @type {Record<string, number>} */
  const tiers = {};
  for (const [option, p] of Object.entries(probabilities)) {
    const tier = OPTIONS[option] ?? 'balanced';
    tiers[tier] = Math.round(((tiers[tier] ?? 0) + p) * 100) / 100;
  }
  return tiers;
}

/**
 * @param {number} input
 * @param {number} output
 * @param {number} cacheRead
 * @param {number} cacheWrite
 * @returns {Usage}
 */
const usage = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite });

/**
 * The route and done events of one request.
 * @param {Beat[]} beats
 * @param {{ at: number, req: number, session: string, surface: string, tier: string, reason: string, kind: string,
 *   dur: number, usage: Usage, jev?: LogEvent }} spec
 */
function request(beats, spec) {
  const chosen = SURFACES[spec.surface][spec.tier] ?? SURFACES.anthropic.balanced;
  const openai = spec.surface === 'openai';
  beats.push({
    at: spec.at,
    make: () => ({
      event: 'route',
      req: spec.req,
      session: spec.session,
      path: openai ? '/v1/responses' : '/v1/messages',
      kind: spec.kind,
      key_source: openai ? 'session-id' : 'x-claude-code-session-id',
      tier: spec.tier,
      reason: spec.reason,
      model: chosen.model,
      upstream: chosen.upstream,
      jev: spec.jev,
    }),
  });
  beats.push({
    at: spec.at + spec.dur,
    make: () => ({
      event: 'done',
      req: spec.req,
      session: spec.session,
      status: 200,
      model: chosen.model,
      ms: spec.dur,
      bytes: 2000 + spec.usage.output * 6,
      usage: spec.usage,
      cost_usd: cost(chosen.model, spec.usage),
      baseline_usd: cost(BASELINE, spec.usage),
    }),
  });
}

/**
 * A human prompt: a deciding event, then the route with Jev's answer, then its done event.
 * @param {Beat[]} beats
 * @param {() => number} nextReq
 * @param {{ at: number, session: string, turn: number, surface?: string, p?: Record<string, number>, tier: string,
 *   reason: string, jevMs: number, gen: number, usage: Usage, sensitive?: number, fail?: string }} spec
 */
function prompt(beats, nextReq, spec) {
  beats.push({ at: spec.at, make: () => ({ event: 'deciding', session: spec.session, turn: spec.turn }) });
  const p = spec.p ?? {};
  const choice = Object.entries(p).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const jev = spec.fail
    ? { ok: false, ms: spec.jevMs, error: spec.fail }
    : {
        ok: true,
        channel: 'typesafe',
        model: 'jev-1.13.0',
        requestId: `gen-dec-${hex(4)}`,
        ms: spec.jevMs,
        inputTokens: 520 + Math.round(Math.random() * 160),
        choice,
        probabilities: p,
        tiers: byTier(p),
        sensitive: spec.sensitive ?? 0.03,
        claim: 0.02,
      };
  request(beats, {
    at: spec.at + spec.jevMs,
    req: nextReq(),
    session: spec.session,
    surface: spec.surface ?? 'anthropic',
    tier: spec.tier,
    reason: spec.reason,
    kind: 'main',
    dur: spec.gen,
    usage: spec.usage,
    jev,
  });
}

/**
 * Requests that don't ask Jev: tool-loop steps, subagents and background calls.
 * @param {Beat[]} beats
 * @param {() => number} nextReq
 * @param {string} session
 * @param {string} tier
 * @param {Array<[at: number, dur: number, kind: string, reason: string, usage: Usage]>} list
 * @param {string} [surface]
 */
function steps(beats, nextReq, session, tier, list, surface = 'anthropic') {
  for (const [at, dur, kind, reason, used] of list) {
    const side = reason === 'side-call';
    request(beats, { at, req: nextReq(), session, surface, tier: side ? 'side' : tier, reason, kind, dur, usage: used });
  }
}

/**
 * One pass of the scenario, about a minute long.
 * @param {() => number} nextReq
 * @returns {Beat[]}
 */
function scenario(nextReq) {
  /** @type {Beat[]} */
  const beats = [];
  const [a, b, c, d, e] = [hex(6), hex(6), hex(6), hex(6), hex(6)];
  const title = usage(320, 12, 0, 0);

  prompt(beats, nextReq, {
    at: 600,
    session: a,
    turn: 1,
    p: { mechanical: 0.91, routine: 0.06, complex: 0.02, deep: 0.01 },
    tier: 'fast',
    reason: 'jev',
    jevMs: 240,
    gen: 1600,
    usage: usage(1200, 180, 21000, 3800),
  });
  steps(beats, nextReq, a, 'fast', [
    [2700, 900, 'main', 'sticky', usage(600, 140, 25000, 900)],
    [3900, 1100, 'main', 'sticky', usage(700, 210, 26000, 1100)],
    [5100, 800, 'main', 'sticky', usage(500, 90, 27500, 700)],
    [6400, 380, 'auxiliary', 'side-call', title],
  ]);

  prompt(beats, nextReq, {
    at: 8500,
    session: a,
    turn: 2,
    p: { complex: 0.78, routine: 0.14, deep: 0.06, mechanical: 0.02 },
    tier: 'frontier',
    reason: 'upgrade:jev',
    jevMs: 410,
    gen: 3200,
    usage: usage(2600, 900, 0, 31000),
  });
  steps(beats, nextReq, a, 'frontier', [
    [12300, 2000, 'main', 'sticky', usage(1800, 640, 33000, 2400)],
    [14000, 450, 'auxiliary', 'side-call', title],
    [15200, 1600, 'main', 'sticky', usage(900, 420, 35500, 1500)],
    [16900, 2800, 'subagent', 'subagent', usage(4200, 1300, 9000, 6000)],
    [18100, 1400, 'main', 'sticky', usage(700, 380, 37000, 1200)],
    [20000, 400, 'auxiliary', 'side-call', title],
    [21000, 1700, 'main', 'sticky', usage(1100, 520, 38200, 1600)],
    [23200, 1200, 'main', 'sticky', usage(600, 300, 39800, 900)],
    [24800, 2400, 'main', 'sticky', usage(1500, 880, 40700, 2100)],
  ]);
  prompt(beats, nextReq, {
    at: 28000,
    session: a,
    turn: 3,
    p: { mechanical: 0.88, routine: 0.09, complex: 0.02, deep: 0.01 },
    tier: 'frontier',
    reason: 'jev-keep',
    jevMs: 260,
    gen: 1100,
    usage: usage(300, 60, 42800, 400),
  });

  prompt(beats, nextReq, {
    at: 31000,
    session: b,
    turn: 1,
    p: { deep: 0.72, complex: 0.22, routine: 0.04, mechanical: 0.02 },
    tier: 'max',
    reason: 'jev',
    jevMs: 520,
    gen: 5500,
    usage: usage(3100, 2400, 18000, 9000),
  });
  steps(beats, nextReq, b, 'max', [
    [37500, 2200, 'main', 'sticky', usage(1600, 900, 27000, 2600)],
    [40300, 1800, 'main', 'sticky', usage(1200, 700, 29600, 1900)],
  ]);

  prompt(beats, nextReq, {
    at: 43000,
    session: c,
    turn: 1,
    p: { routine: 0.71, mechanical: 0.17, complex: 0.1, deep: 0.02 },
    sensitive: 0.86,
    tier: 'max',
    reason: 'risk-override',
    jevMs: 330,
    gen: 3100,
    usage: usage(1900, 760, 17500, 5200),
  });

  prompt(beats, nextReq, {
    at: 47500,
    session: d,
    turn: 1,
    surface: 'openai',
    p: { routine: 0.83, mechanical: 0.11, complex: 0.05, deep: 0.01 },
    tier: 'balanced',
    reason: 'jev',
    jevMs: 290,
    gen: 2200,
    usage: usage(5200, 610, 12000, 0),
  });
  steps(beats, nextReq, d, 'balanced', [[50400, 1400, 'main', 'sticky', usage(900, 340, 16800, 0)]], 'openai');

  prompt(beats, nextReq, {
    at: 53000,
    session: e,
    turn: 1,
    fail: 'deadline of 2500 ms exceeded on every channel',
    tier: 'balanced',
    reason: 'fallback:default',
    jevMs: 2500,
    gen: 2000,
    usage: usage(1400, 380, 16000, 4100),
  });
  return beats;
}

/**
 * Plays the demo until the returned function is called.
 * @param {Emit} emit receives each event, stamped with the time it happens
 * @returns {() => void} stops the demo
 */
export function startDemo(emit) {
  let req = 0;
  let stopped = false;
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set();
  /** @param {LogEvent} event */
  const stamp = (event) => emit({ ts: new Date().toISOString(), ...event });
  /**
   * @param {number} ms
   * @param {() => void} run
   */
  const later = (ms, run) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) run();
    }, ms);
    timers.add(timer);
  };
  const loop = () => {
    for (const beat of scenario(() => ++req)) later(beat.at, () => stamp(beat.make()));
    later(LOOP_MS, loop);
  };
  stamp(configEvent());
  later(400, loop);
  return () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
