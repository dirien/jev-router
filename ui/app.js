// jev-router live view. Streams the router's JSON log from /events and shows each Jev decision
// and how every request was routed. The DOM is built with createElement and textContent only:
// event data never reaches innerHTML.

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_ROUTES = 2000;
const MAX_ROWS = 200;
const MAX_GROUPS = 80;
const MAX_STEPS_SHOWN = 10;
const MAX_SESSIONS = 6;
const MAX_STAIRS = 28;
const MAX_PARTICLES = 24;
const MAX_LATENCIES = 500;
const PENDING_TTL_MS = 30_000;
const TIER_PALETTE = ['fast', 'balanced', 'frontier', 'max'];
const HUMAN_REASONS = new Set(['tag', 'pinned', 'no-jev']);
/** @type {Record<string, string>} */
const CLIENTS = { anthropic: 'Claude Code', openai: 'Codex' };
// The same stacks as --font and --mono in app.css, so measured widths match the rendered text.
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const LABEL_FONT = `600 12.5px ${SANS}`;
const SMALL_LABEL_FONT = `600 11.5px ${SANS}`;
const MONO_FONT = `11px ${MONO}`;

/**
 * @typedef {{ ok: boolean, channel: string, model: string, ms: number | undefined, inputTokens: number | undefined,
 *   choice: string, probabilities: Record<string, number>, tiers: Record<string, number>, sensitive: number | undefined,
 *   claim: number | undefined, hardened: boolean, error: string }} Jev
 * @typedef {{ event: 'route', ts: number, req: number | undefined, session: string, path: string, kind: string, tier: string,
 *   reason: string, model: string, upstream: string, trustedOnly: boolean, jev: Jev | undefined }} RouteEvent
 * @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number }} Usage
 * @typedef {{ event: 'done', ts: number, req: number | undefined, session: string, status: number, model: string,
 *   ms: number | undefined, usage: Usage | undefined, cost: number | undefined, baseline: number | undefined }} DoneEvent
 * @typedef {{ event: 'deciding', ts: number, session: string, turn: number | undefined }} DecidingEvent
 * @typedef {{ model: string, upstream: string, trusted: boolean }} Target
 * @typedef {{ event: 'config', ts: number, version: string, mode: string, tiers: string[], defaultTier: string,
 *   options: Record<string, string>, accept: Record<string, number>, sensitiveOverride: number | undefined,
 *   claimGuard: number | undefined, surfaces: Record<string, Record<string, Target>>,
 *   channels: Array<{ name: string, model: string, host: string }> }} ConfigEvent
 * @typedef {{ event: 'note', ts: number, level: 'info' | 'warn' | 'error', text: string, req: number | undefined }} NoteEvent
 * @typedef {RouteEvent | DoneEvent | DecidingEvent | ConfigEvent | NoteEvent} AppEvent
 *
 * @typedef {{ id: number, route: RouteEvent, surface: string, head: boolean, done: DoneEvent | undefined, error: string,
 *   live: boolean, flashed: boolean, inflight: boolean, cell: HTMLElement | undefined }} RouteRec
 * @typedef {{ session: string, head: RouteRec | undefined, steps: RouteRec[], live: boolean, shown: number, hidden: number,
 *   el: HTMLElement | undefined, stepsEl: HTMLElement | undefined, moreEl: HTMLElement | undefined }} Group
 * @typedef {{ tier: string, model: string, reason: string, choice: string, live: boolean }} Turn
 * @typedef {{ id: string, surface: string, turns: Turn[], turnCount: number, tier: string, model: string, spend: number,
 *   last: number, requests: number }} Session
 * @typedef {{ count: number, spend: number, inflight: number, tier: string }} ModelStat
 */

// ---------------------------------------------------------------------------------------------
// Small helpers

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObj = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value
 * @returns {value is string}
 */
const isString = (value) => typeof value === 'string';

/**
 * @param {unknown} value
 * @param {string} [fallback]
 */
const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback);

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * @param {unknown} value
 * @returns {Record<string, number>}
 */
function numMap(value) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!isObj(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    const n = num(raw);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

/** @param {unknown} value */
function timeOf(value) {
  const t = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(t) ? t : Date.now();
}

/** @param {string} text */
function parse(text) {
  try {
    return /** @type {unknown} */ (JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
const uniq = (items) => [...new Set(items)];

/** @param {number | undefined} p */
const pct = (p) => (p === undefined ? '–' : `${Math.round(p * 100)}%`);

/** @param {number | undefined} ms */
function dur(ms) {
  if (ms === undefined) return '–';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** @param {number | undefined} usd */
function money(usd) {
  if (usd === undefined) return '–';
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return usd === 0 ? '$0' : `$${usd.toFixed(4)}`;
}

/** @param {number} n */
function tokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** @param {number} ts */
function clock(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/**
 * "1 request", "2 requests".
 * @param {number} n
 * @param {string} word
 */
function count(n, word) {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/**
 * The footer of a session lane.
 * @param {Session} session
 */
function laneFoot(session) {
  return `${count(session.turnCount, 'prompt')} · ${count(session.requests, 'request')} · ${ago(session.last)}`;
}

/** @param {number} ts */
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** @param {number[]} values */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** @param {string} session */
const short = (session) => session.slice(0, 6) || '––––––';

/** @param {string} session */
function hue(session) {
  const n = Number.parseInt(session.slice(0, 6), 16);
  if (Number.isFinite(n)) return n % 360;
  let h = 0;
  for (const ch of session) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** @param {string} word */
const cap = (word) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * "claude-opus-5-5" → "Opus 5.5"; other names stay as they are.
 * @param {string} model
 */
function shortModel(model) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  if (!m) return model || '?';
  return `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** @param {string} path */
const surfaceOf = (path) => (path.startsWith('/v1/responses') ? 'openai' : 'anthropic');

/** @param {string} surface */
const clientName = (surface) => CLIENTS[surface] ?? surface;

/** @param {RouteEvent} route */
const isCount = (route) => route.path.endsWith('/count_tokens');

/** @param {string} reason */
const baseReason = (reason) => reason.replace(/^upgrade:/, '');

/**
 * A human prompt: Jev was asked, or a person chose the tier (tag, pin, /model).
 * @param {RouteEvent} route
 */
function isPrompt(route) {
  const base = baseReason(route.reason);
  return route.jev !== undefined || HUMAN_REASONS.has(base) || base.startsWith('client-model:');
}

// ---------------------------------------------------------------------------------------------
// Normalizing log lines: anything malformed is dropped or filled with safe defaults.

/**
 * @param {unknown} value
 * @returns {Jev | undefined}
 */
function normJev(value) {
  if (!isObj(value)) return undefined;
  return {
    ok: value.ok === true,
    channel: str(value.channel),
    model: str(value.model),
    ms: num(value.ms),
    inputTokens: num(value.inputTokens),
    choice: str(value.choice),
    probabilities: numMap(value.probabilities),
    tiers: numMap(value.tiers),
    sensitive: num(value.sensitive),
    claim: num(value.claim),
    hardened: value.hardened === true,
    error: str(value.error),
  };
}

/**
 * @param {Record<string, unknown>} raw
 * @param {number} ts
 * @returns {RouteEvent}
 */
function normRoute(raw, ts) {
  return {
    event: 'route',
    ts,
    req: num(raw.req),
    session: str(raw.session),
    path: str(raw.path, '/v1/messages'),
    kind: str(raw.kind),
    tier: str(raw.tier, '?'),
    reason: str(raw.reason, '?'),
    model: str(raw.model, '?'),
    upstream: str(raw.upstream),
    trustedOnly: raw.trusted_only === true,
    jev: normJev(raw.jev),
  };
}

/**
 * @param {Record<string, unknown>} raw
 * @param {number} ts
 * @returns {DoneEvent}
 */
function normDone(raw, ts) {
  const u = isObj(raw.usage) ? raw.usage : undefined;
  return {
    event: 'done',
    ts,
    req: num(raw.req),
    session: str(raw.session),
    status: num(raw.status) ?? 0,
    model: str(raw.model),
    ms: num(raw.ms),
    usage: u && {
      input: num(u.input) ?? 0,
      output: num(u.output) ?? 0,
      cacheRead: num(u.cacheRead) ?? 0,
      cacheWrite: num(u.cacheWrite) ?? 0,
    },
    cost: num(raw.cost_usd),
    baseline: num(raw.baseline_usd),
  };
}

/**
 * @param {unknown} value
 * @returns {Record<string, Record<string, Target>>}
 */
function normSurfaces(value) {
  /** @type {Record<string, Record<string, Target>>} */
  const surfaces = {};
  if (!isObj(value)) return surfaces;
  for (const [surface, targets] of Object.entries(value)) {
    if (!isObj(targets)) continue;
    /** @type {Record<string, Target>} */
    const out = {};
    for (const [role, t] of Object.entries(targets)) {
      if (isObj(t) && isString(t.model)) out[role] = { model: t.model, upstream: str(t.upstream), trusted: t.trusted === true };
    }
    surfaces[surface] = out;
  }
  return surfaces;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {number} ts
 * @returns {ConfigEvent}
 */
function normConfig(raw, ts) {
  /** @type {Record<string, string>} */
  const options = {};
  if (isObj(raw.options)) for (const [name, tier] of Object.entries(raw.options)) if (isString(tier)) options[name] = tier;
  const jev = isObj(raw.jev) ? raw.jev : {};
  const channels = Array.isArray(jev.channels) ? jev.channels.filter(isObj) : [];
  return {
    event: 'config',
    ts,
    version: str(raw.version),
    mode: str(raw.mode),
    tiers: Array.isArray(raw.tiers) ? raw.tiers.filter(isString) : [],
    defaultTier: str(raw.defaultTier),
    options,
    accept: numMap(raw.accept),
    sensitiveOverride: num(raw.sensitiveOverride),
    claimGuard: num(raw.claimGuard),
    surfaces: normSurfaces(raw.surfaces),
    channels: channels.map((c) => ({ name: str(c.name), model: str(c.model), host: str(c.host) })),
  };
}

/**
 * @param {unknown} raw
 * @returns {AppEvent | undefined}
 */
function normalize(raw) {
  if (!isObj(raw)) return undefined;
  const ts = timeOf(raw.ts);
  switch (raw.event) {
    case 'route':
      return normRoute(raw, ts);
    case 'done':
      return normDone(raw, ts);
    case 'deciding':
      return { event: 'deciding', ts, session: str(raw.session), turn: num(raw.turn) };
    case 'config':
      return normConfig(raw, ts);
    case 'error':
      return { event: 'note', ts, level: 'error', text: str(raw.error, 'error'), req: num(raw.req) };
    case 'warning':
      return { event: 'note', ts, level: 'warn', text: str(raw.message), req: undefined };
    case 'text':
      return { event: 'note', ts, level: 'info', text: str(raw.text), req: undefined };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// State

function freshState() {
  return {
    /** @type {ConfigEvent | undefined} */
    config: undefined,
    file: '',
    /** @type {Map<number, RouteRec>} */
    routes: new Map(),
    /** @type {Group[]} */
    groups: [],
    /** @type {Map<string, Group>} */
    openGroups: new Map(),
    /** @type {Map<string, Session>} */
    sessions: new Map(),
    /** @type {Map<string, DecidingEvent>} */
    pending: new Map(),
    /** @type {RouteRec | undefined} */
    latest: undefined,
    /** @type {Map<string, ModelStat>} */
    models: new Map(),
    /** @type {Map<string, { surface: string, tier: string }>} */
    seenModels: new Map(),
    /** @type {Set<string>} */
    seenSurfaces: new Set(),
    /** @type {Set<string>} */
    seenOptions: new Set(),
    /** @type {Set<string>} */
    seenTiers: new Set(),
    totals: { requests: 0, prompts: 0, fallbacks: 0, spend: 0, baseline: 0, priced: 0, jevMs: /** @type {number[]} */ ([]) },
    synthetic: 0,
  };
}

let state = freshState();
let connection = 'connecting';
let replaying = false;
/** @type {Set<RouteRec>} */
const dirtyRecs = new Set();

/** @param {string} option */
const optionTier = (option) => state.config?.options[option];

/** @param {string} tier */
function tierColor(tier) {
  if (tier === 'side' || tier === 'trusted' || TIER_PALETTE.includes(tier)) return `var(--${tier})`;
  const rank = state.config?.tiers.indexOf(tier) ?? -1;
  return rank >= 0 ? `var(--${TIER_PALETTE[Math.min(rank, TIER_PALETTE.length - 1)]})` : 'var(--neutral)';
}

/**
 * @param {HTMLElement | SVGElement} el
 * @param {string | undefined} tier
 */
function paint(el, tier) {
  el.style.setProperty('--c', tier ? tierColor(tier) : 'var(--neutral)');
}

/** @param {string} model */
function modelStat(model) {
  let stat = state.models.get(model);
  if (!stat) {
    stat = { count: 0, spend: 0, inflight: 0, tier: '' };
    state.models.set(model, stat);
  }
  return stat;
}

// ---------------------------------------------------------------------------------------------
// Applying events

/** @param {ConfigEvent} ev */
function applyConfig(ev) {
  state.config = ev;
  schedule('layout', 'header', 'hero');
}

/**
 * @param {DecidingEvent} ev
 * @param {boolean} live
 */
function applyDeciding(ev, live) {
  if (!ev.session) return;
  state.pending.set(ev.session, ev);
  if (live) showGhost(ev);
  schedule('hero', 'graph');
}

/**
 * @param {RouteRec} rec
 */
function noteSeen(rec) {
  const { route, surface } = rec;
  let grew = !state.seenSurfaces.has(surface) || !state.seenModels.has(route.model);
  state.seenSurfaces.add(surface);
  if (!state.seenModels.has(route.model) || state.seenModels.get(route.model)?.tier === 'side') {
    state.seenModels.set(route.model, { surface, tier: route.tier });
  }
  if (!state.seenTiers.has(route.tier)) grew = true;
  state.seenTiers.add(route.tier);
  for (const option of Object.keys(route.jev?.probabilities ?? {})) {
    if (!state.seenOptions.has(option)) grew = true;
    state.seenOptions.add(option);
  }
  if (grew && graph && !graphHas(rec)) schedule('layout');
}

/** @param {RouteRec} rec */
function tally(rec) {
  const { route } = rec;
  const t = state.totals;
  t.requests += 1;
  if (rec.head) t.prompts += 1;
  if (route.jev && !route.jev.ok) t.fallbacks += 1;
  if (route.jev?.ok && route.jev.ms !== undefined) {
    t.jevMs.push(route.jev.ms);
    if (t.jevMs.length > MAX_LATENCIES) t.jevMs.shift();
  }
  const stat = modelStat(route.model);
  stat.count += 1;
  if (!stat.tier || stat.tier === 'side') stat.tier = route.tier;
  if (rec.inflight) stat.inflight += 1;
}

/** @param {RouteRec} rec */
function remember(rec) {
  state.routes.set(rec.id, rec);
  if (state.routes.size <= MAX_ROUTES) return;
  const oldest = state.routes.keys().next();
  if (!oldest.done) state.routes.delete(oldest.value);
}

/** @param {RouteRec} rec */
function placeInGroup(rec) {
  const session = rec.route.session;
  let group = rec.head ? undefined : state.openGroups.get(session);
  if (!group) {
    group = {
      session,
      head: rec.head ? rec : undefined,
      steps: [],
      live: rec.live,
      shown: 0,
      hidden: 0,
      el: undefined,
      stepsEl: undefined,
      moreEl: undefined,
    };
    state.groups.push(group);
    state.openGroups.set(session, group);
  }
  if (!rec.head) group.steps.push(rec);
  trimGroups();
}

function trimGroups() {
  const rows = () => state.groups.reduce((sum, g) => sum + 1 + Math.min(g.steps.length, MAX_STEPS_SHOWN), 0);
  while (state.groups.length > MAX_GROUPS || (state.groups.length > 1 && rows() > MAX_ROWS)) {
    const old = state.groups.shift();
    if (!old) break;
    old.el?.remove();
    if (state.openGroups.get(old.session) === old) state.openGroups.delete(old.session);
  }
}

/** @param {RouteRec} rec */
function trackSession(rec) {
  const { route } = rec;
  if (!route.session) return;
  let session = state.sessions.get(route.session);
  if (!session) {
    session = {
      id: route.session,
      surface: rec.surface,
      turns: [],
      turnCount: 0,
      tier: '',
      model: '',
      spend: 0,
      last: route.ts,
      requests: 0,
    };
    state.sessions.set(route.session, session);
  }
  session.last = Math.max(session.last, route.ts);
  session.requests += 1;
  if (rec.head) {
    session.turns.push({
      tier: route.tier,
      model: route.model,
      reason: route.reason,
      choice: route.jev?.ok ? route.jev.choice : '',
      live: rec.live,
    });
    session.turnCount += 1;
    if (session.turns.length > MAX_STAIRS) session.turns.shift();
  }
  if (route.tier !== 'side' && !isCount(route)) {
    session.tier = route.tier;
    session.model = route.model;
  }
  if (state.sessions.size > 60) {
    const stalest = [...state.sessions.values()].sort((a, b) => a.last - b.last)[0];
    if (stalest) state.sessions.delete(stalest.id);
  }
}

/**
 * @param {RouteEvent} route
 * @param {boolean} live
 */
function applyRoute(route, live) {
  const surface = surfaceOf(route.path);
  state.synthetic -= route.req === undefined ? 1 : 0;
  /** @type {RouteRec} */
  const rec = {
    id: route.req ?? state.synthetic,
    route,
    surface,
    head: isPrompt(route),
    done: undefined,
    error: '',
    live,
    flashed: false,
    inflight: !isCount(route),
    cell: undefined,
  };
  remember(rec);
  noteSeen(rec);
  tally(rec);
  placeInGroup(rec);
  trackSession(rec);
  if (rec.head) {
    state.latest = rec;
    state.pending.delete(route.session);
    dropGhost(route.session);
  }
  if (live) {
    // A route that reveals a new node rebuilds the graph first; its particle waits for that.
    if (dirty.has('layout')) queuedParticles.push(rec);
    else animateRoute(rec);
    if (rec.head) announce(rec);
  }
  schedule('hero', 'feed', 'graph', 'sessions', 'totals');
}

/** @param {RouteRec} rec */
function settle(rec) {
  if (!rec.inflight) return;
  rec.inflight = false;
  const stat = modelStat(rec.route.model);
  stat.inflight = Math.max(0, stat.inflight - 1);
}

/** @param {DoneEvent} ev */
function applyDone(ev) {
  const cost = ev.cost ?? 0;
  const t = state.totals;
  t.spend += cost;
  t.baseline += ev.baseline ?? cost;
  if (ev.cost !== undefined) t.priced += 1;
  if (ev.model) modelStat(ev.model).spend += cost;
  const session = state.sessions.get(ev.session);
  if (session) session.spend += cost;
  const rec = ev.req === undefined ? undefined : state.routes.get(ev.req);
  if (rec && !rec.done) {
    rec.done = ev;
    settle(rec);
    dirtyRecs.add(rec);
  }
  schedule('feed', 'graph', 'sessions', 'totals');
}

/**
 * @param {NoteEvent} ev
 * @param {boolean} live
 */
function applyNote(ev, live) {
  const rec = ev.req === undefined ? undefined : state.routes.get(ev.req);
  if (rec) {
    rec.error = ev.text;
    settle(rec);
    dirtyRecs.add(rec);
  }
  if (live && ev.text) toast(ev.text.replace(/^jev-router:\s*/, ''), ev.level);
  schedule('feed', 'graph');
}

/**
 * @param {AppEvent} ev
 * @param {boolean} live
 */
function apply(ev, live) {
  if (ev.event === 'config') applyConfig(ev);
  else if (ev.event === 'deciding') applyDeciding(ev, live);
  else if (ev.event === 'route') applyRoute(ev, live);
  else if (ev.event === 'done') applyDone(ev);
  else applyNote(ev, live);
}

function prunePending() {
  const now = Date.now();
  let changed = false;
  for (const [session, ev] of state.pending) {
    if (now - ev.ts <= PENDING_TTL_MS) continue;
    state.pending.delete(session);
    dropGhost(session);
    changed = true;
  }
  if (changed) schedule('hero', 'graph');
}

// ---------------------------------------------------------------------------------------------
// DOM building

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * @template {keyof SVGElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, string | number>} [attrs]
 * @returns {SVGElementTagNameMap[K]}
 */
function s(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

/**
 * @param {string} content
 * @param {number} x
 * @param {number} y
 * @param {string} className
 */
function svgText(content, x, y, className) {
  const t = s('text', { x, y, class: className });
  t.textContent = content;
  return t;
}

/** @param {string} id */
function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`The page is missing #${id}`);
  return el;
}

function flowSvg() {
  const el = document.querySelector('#flow');
  if (!(el instanceof SVGSVGElement)) throw new Error('The page is missing the #flow graph');
  return el;
}

const dom = {
  conn: byId('conn'),
  connLabel: byId('conn-label'),
  file: byId('meta-file'),
  version: byId('meta-version'),
  mode: byId('meta-mode'),
  tiermap: byId('tiermap'),
  hero: byId('hero'),
  heroWhen: byId('hero-when'),
  catName: byId('cat-name'),
  catConf: byId('cat-conf'),
  heroRoute: byId('hero-route'),
  classifying: byId('classifying-text'),
  heroReason: byId('hero-reason'),
  heroExplain: byId('hero-explain'),
  bars: byId('bars'),
  barsNote: byId('bars-note'),
  tierbars: byId('tierbars'),
  guards: byId('guards'),
  jevmeta: byId('jevmeta'),
  flowWrap: byId('flow-wrap'),
  flow: flowSvg(),
  feed: byId('feed'),
  feedEmpty: byId('feed-empty'),
  feedNote: byId('feed-note'),
  sessions: byId('sessions'),
  sessionsEmpty: byId('sessions-empty'),
  tiles: byId('tiles'),
  mbars: byId('mbars'),
  totalsNote: byId('totals-note'),
  toasts: byId('toasts'),
  announce: byId('announce'),
};

/** @type {WeakMap<Element, ReturnType<typeof setTimeout>>} */
const classTimers = new WeakMap();

/**
 * Replays a one-shot CSS animation class.
 * @param {Element} el
 * @param {string} cls
 * @param {number} ms
 */
function restartClass(el, cls, ms) {
  el.classList.remove(cls);
  el.getBoundingClientRect();
  el.classList.add(cls);
  clearTimeout(classTimers.get(el));
  classTimers.set(
    el,
    setTimeout(() => el.classList.remove(cls), ms),
  );
}

/**
 * @param {string} label
 * @param {string | undefined} tier
 */
function chip(label, tier) {
  const el = h('span', 'chip', label);
  paint(el, tier);
  return el;
}

/** @param {string} reason */
function reasonKind(reason) {
  if (reason.startsWith('upgrade:')) return 'up';
  if (reason === 'jev' || reason === 'jev-escalated') return 'jev';
  if (reason === 'jev-keep') return 'keep';
  if (reason === 'risk-override' || reason === 'claim-guard') return 'guard';
  if (reason.startsWith('fallback') || reason === 'no-jev' || reason === 'client-aborted') return 'fail';
  if (reason === 'side-call') return 'side';
  if (reason === 'tag' || reason === 'pinned' || reason.startsWith('client-model:')) return 'manual';
  return 'loop';
}

/**
 * @param {HTMLElement} el
 * @param {string} reason
 */
function setReason(el, reason) {
  el.textContent = reason;
  el.dataset.kind = reasonKind(reason);
  el.title = explainReason(reason);
  return el;
}

/** @param {string} reason */
function explainReason(reason) {
  const base = baseReason(reason);
  /** @type {Record<string, string>} */
  const plain = {
    jev: 'Jev was sure enough about its category',
    'jev-escalated': 'Jev was unsure, so the router took the more capable of its top two tiers',
    'jev-keep': "Kept the session's tier: the router never moves down mid-session",
    'risk-override': 'Sensitive change: the top tier takes it',
    'claim-guard': 'The message claimed a routing decision, so the router refused to go lower',
    tag: 'You tagged the message with a tier',
    pinned: 'Pinned by the x-jev-tier header or JEV_ROUTER_TIER',
    sticky: 'Tool-loop step: same model, Jev not asked',
    'sticky:history-shrank': 'The conversation got shorter: same model, Jev not asked',
    'side-call': 'Claude Code background call on the side model',
    'count-tokens': "Token count for the client's context meter",
    'fallback:default': 'Jev did not answer: default tier for now, asked again next message',
    'fallback:keep': 'Jev did not answer: the session keeps its tier',
    'client-aborted': 'Cancelled before Jev answered',
    'no-jev': 'No Jev key configured: default tier',
    'no-prompt': "Mid-loop request from a session the router doesn't know yet",
    subagent: "Subagent request: runs on the session's tier",
    compaction: "Compaction request: runs on the session's tier",
    workflow: "Workflow request: runs on the session's tier",
  };
  const text = base.startsWith('client-model:') ? 'You switched models with /model' : (plain[base] ?? `Routing rule "${reason}"`);
  return reason.startsWith('upgrade:') ? `Moved up. ${text}` : text;
}

/** @param {RouteRec} rec */
function explain(rec) {
  const { route } = rec;
  const jev = route.jev;
  const base = baseReason(route.reason);
  const target = `${route.tier} → ${shortModel(route.model)}`;
  const p = jev?.ok ? jev.probabilities[jev.choice] : undefined;
  const cfg = state.config;
  const up = route.reason.startsWith('upgrade:') ? 'Moved up: the router never moves down mid-session. ' : '';
  if (base.startsWith('client-model:')) return `You switched to ${base.slice(13)} with /model, which pins ${target}.`;
  switch (base) {
    case 'jev':
      return `${up}Jev was ${pct(p)} sure: ${jev?.choice} → ${target}.`;
    case 'jev-escalated': {
      const bar = cfg?.accept[optionTier(jev?.choice ?? '') ?? ''];
      return `${up}Jev leaned ${jev?.choice} (${pct(p)}), under the ${pct(bar)} bar, so the router took the more capable of its top two tiers: ${target}.`;
    }
    case 'jev-keep':
      return `Jev rated this ${jev?.choice} (${pct(p)}), but the session keeps ${target}: the router never moves down mid-session.`;
    case 'risk-override':
      return `${up}Sensitive change (${pct(jev?.sensitive)} against a ${pct(cfg?.sensitiveOverride)} bar): the top tier takes it, ${target}.`;
    case 'claim-guard':
      return `${up}The message claims the routing was already decided (${pct(jev?.claim)}), so the router refused to go below ${target}.`;
    case 'tag':
      return `You tagged the message #${route.tier}: ${target}. Jev was not asked.`;
    case 'pinned':
      return `Pinned by the x-jev-tier header or JEV_ROUTER_TIER: ${target}.`;
    case 'fallback:default':
      return `Jev did not answer (${jev?.error || 'no answer'}), so the router used the default tier for now and asks again next message: ${target}.`;
    case 'fallback:keep':
      return `Jev did not answer (${jev?.error || 'no answer'}), so the session keeps ${target}.`;
    case 'no-jev':
      return `No Jev key is configured, so every session uses the default tier: ${target}.`;
    default:
      return `${explainReason(route.reason)}: ${target}.`;
  }
}

// ---------------------------------------------------------------------------------------------
// Header

/** @type {Record<string, string>} */
const CONNECTION_LABELS = { connecting: 'connecting', live: 'live', reconnecting: 'reconnecting', closed: 'disconnected' };

function renderHeader() {
  dom.conn.dataset.state = connection;
  dom.connLabel.textContent = CONNECTION_LABELS[connection] ?? connection;
  dom.file.textContent = state.file ? `log ${state.file}` : '';
  const cfg = state.config;
  dom.version.textContent = cfg?.version && /^v?\d/.test(cfg.version) ? `v${cfg.version.replace(/^v/, '')}` : (cfg?.version ?? '');
  dom.mode.textContent = cfg?.mode ? `mode ${cfg.mode}` : '';
  dom.tiermap.replaceChildren();
  if (!cfg) {
    dom.tiermap.append(h('span', 'map-note', connection === 'live' ? "Tier map: waiting for the router's config line" : ''));
    return;
  }
  const targets = cfg.surfaces.anthropic ?? Object.values(cfg.surfaces)[0] ?? {};
  for (const tier of [...cfg.tiers, 'side']) {
    const t = targets[tier];
    if (!t) continue;
    const el = h('span', 'map-chip');
    paint(el, tier);
    el.title = `${t.model} on ${t.upstream}`;
    el.append(h('b', '', tier), h('span', 'arrow', '→'), h('span', '', shortModel(t.model)));
    dom.tiermap.append(el);
  }
}

/** @param {string} value */
function setConnection(value) {
  connection = value;
  schedule('header');
}

// ---------------------------------------------------------------------------------------------
// Hero: the latest decision

/** @typedef {{ row: HTMLElement, fill: HTMLElement, value: HTMLElement, tick: HTMLElement | undefined }} BarRow */

/**
 * @param {string} label
 * @param {boolean} withTick
 * @returns {BarRow}
 */
function barRow(label, withTick) {
  const row = h('div', 'bar-row');
  const bar = h('div', 'bar');
  const fill = h('div', 'bar-fill');
  bar.append(fill);
  const tick = withTick ? h('span', 'tick') : undefined;
  if (tick) bar.append(tick);
  const value = h('span', 'bar-value');
  const name = h('span', 'bar-label', label);
  name.title = label;
  row.append(name, bar, value);
  return { row, fill, value, tick };
}

/**
 * Keeps one row per name, rebuilding only when the set of names changes.
 * @param {HTMLElement} box
 * @param {Map<string, BarRow>} rows
 * @param {string[]} names
 * @param {boolean} withTick
 */
function syncBars(box, rows, names, withTick) {
  const key = names.join('|');
  if (box.dataset.key === key) return false;
  box.replaceChildren();
  rows.clear();
  for (const name of names) {
    const row = barRow(name, withTick);
    rows.set(name, row);
    box.append(row.row);
  }
  box.dataset.key = key;
  return true;
}

/** @type {Map<string, BarRow>} */
const optionRows = new Map();
/** @type {Map<string, BarRow>} */
const tierRows = new Map();

/**
 * Sets a bar's width, after the next frame when its row is new so the width animates in.
 * @param {HTMLElement} fill
 * @param {number} p
 * @param {boolean} fresh
 */
function setWidth(fill, p, fresh) {
  const width = `${Math.round(Math.max(0, Math.min(1, p)) * 1000) / 10}%`;
  if (fresh) requestAnimationFrame(() => fill.style.setProperty('width', width));
  else fill.style.setProperty('width', width);
}

/** @param {Jev | undefined} jev */
function renderOptionBars(jev) {
  const cfg = state.config;
  const names = uniq([...Object.keys(cfg?.options ?? {}), ...Object.keys(jev?.probabilities ?? {})]);
  const fresh = syncBars(dom.bars, optionRows, names, false);
  for (const [name, row] of optionRows) {
    const p = jev?.ok ? (jev.probabilities[name] ?? 0) : 0;
    paint(row.row, optionTier(name) ?? '');
    row.row.classList.toggle('chosen', jev?.ok === true && jev.choice === name);
    row.value.textContent = jev?.ok ? pct(p) : '–';
    setWidth(row.fill, p, fresh);
  }
  dom.barsNote.textContent = jev?.ok ? 'one Choice question' : jev ? 'no answer' : 'Jev not asked';
}

/**
 * @param {Jev | undefined} jev
 * @param {string} chosen
 */
function renderTierBars(jev, chosen) {
  const cfg = state.config;
  const names = uniq([...(cfg?.tiers ?? []), ...Object.keys(jev?.tiers ?? {})]);
  const fresh = syncBars(dom.tierbars, tierRows, names, true);
  const tiers = jev?.ok ? jev.tiers : {};
  const top = Object.entries(tiers).sort((a, b) => b[1] - a[1])[0]?.[0];
  for (const [name, row] of tierRows) {
    const p = tiers[name] ?? 0;
    const bar = cfg?.accept[name];
    paint(row.row, name);
    row.row.classList.toggle('chosen', name === chosen);
    row.row.classList.toggle('below', name === top && bar !== undefined && p < bar);
    row.value.textContent = jev?.ok ? pct(p) : '–';
    row.tick?.style.setProperty('left', `${(bar ?? 0) * 100}%`);
    row.tick?.toggleAttribute('hidden', bar === undefined);
    if (row.tick) row.tick.title = bar === undefined ? '' : `accept at ${pct(bar)}`;
    setWidth(row.fill, p, fresh);
  }
}

/**
 * @param {string} name
 * @param {string} rule
 * @param {number | undefined} value
 * @param {number | undefined} bar
 */
function guard(name, rule, value, bar) {
  const box = h('div', 'guard');
  const hot = value !== undefined && bar !== undefined && value >= bar;
  box.classList.toggle('hot', hot);
  const title = h('div', 'guard-name');
  title.append(h('span', '', hot ? `${name}: triggered` : name), h('em', '', rule));
  const row = barRow('', true);
  row.row.firstElementChild?.remove();
  row.value.textContent = pct(value);
  row.tick?.style.setProperty('left', `${(bar ?? 0) * 100}%`);
  paint(row.row, hot ? undefined : 'balanced');
  if (hot) row.row.style.setProperty('--c', 'var(--bad)');
  setWidth(row.fill, value ?? 0, true);
  box.append(title, row.row);
  return box;
}

/** @param {Jev | undefined} jev */
function renderGuards(jev) {
  const cfg = state.config;
  if (!jev?.ok) {
    dom.guards.replaceChildren();
    return;
  }
  dom.guards.replaceChildren(
    guard('Sensitive change', `≥ ${pct(cfg?.sensitiveOverride)} → top tier`, jev.sensitive, cfg?.sensitiveOverride),
    guard('Routing claim', `≥ ${pct(cfg?.claimGuard)} → no downgrade`, jev.claim, cfg?.claimGuard),
  );
}

/** @param {Jev | undefined} jev */
function renderJevMeta(jev) {
  /** @type {Array<[string, string]>} */
  const items = [];
  if (jev?.ok) {
    items.push(['channel', jev.channel || '–'], ['model', jev.model || '–'], ['latency', dur(jev.ms)]);
    if (jev.inputTokens !== undefined) items.push(['tokens', String(jev.inputTokens)]);
    if (jev.hardened) items.push(['firewall', 'retried with a hardened state']);
  } else if (jev) {
    items.push(['Jev', `failed after ${dur(jev.ms)}`], ['error', jev.error || 'unknown']);
  } else {
    items.push(['Jev', 'not asked for this message']);
  }
  dom.jevmeta.replaceChildren(
    ...items.map(([k, v]) => {
      const item = h('div');
      item.append(h('dt', '', k), h('dd', '', v));
      return item;
    }),
  );
}

/** @param {RouteEvent} route */
function manualLabel(route) {
  const base = baseReason(route.reason);
  if (base === 'tag') return `#${route.tier}`;
  if (base.startsWith('client-model:')) return `/model ${base.slice(13)}`;
  if (base === 'pinned') return 'pinned';
  return 'no Jev';
}

/** @param {RouteRec} rec */
function renderDecision(rec) {
  const { route } = rec;
  const jev = route.jev;
  paint(dom.hero, route.tier);
  if (jev?.ok) {
    dom.catName.textContent = cap(jev.choice || '?');
    dom.catConf.textContent = `${pct(jev.probabilities[jev.choice])} sure · maps to ${optionTier(jev.choice) ?? '?'}`;
  } else {
    dom.catName.textContent = jev ? 'No answer' : manualLabel(route);
    dom.catConf.textContent = jev ? `Jev failed: ${jev.error || 'unknown error'}` : 'Jev was not asked';
  }
  dom.heroRoute.replaceChildren(
    h('span', 'client', clientName(rec.surface)),
    h('span', 'arrow', '→'),
    chip(route.tier, route.tier),
    h('span', 'arrow', '→'),
    h('span', 'model', shortModel(route.model)),
  );
  dom.heroRoute.title = `${route.model} on ${route.upstream}`;
  setReason(dom.heroReason, route.reason);
  dom.heroExplain.textContent = explain(rec);
  renderOptionBars(jev);
  renderTierBars(jev, route.tier);
  renderGuards(jev);
  renderJevMeta(jev);
  dom.heroWhen.textContent = `${clock(route.ts)} · ${ago(route.ts)}`;
  if (rec.live && !rec.flashed) {
    rec.flashed = true;
    restartClass(dom.hero, 'flash', 1200);
  }
}

function newestPending() {
  let newest;
  for (const ev of state.pending.values()) if (!newest || ev.ts > newest.ts) newest = ev;
  return newest;
}

function renderHero() {
  const rec = state.latest;
  const pending = newestPending();
  const deciding = pending !== undefined && (!rec || pending.ts >= rec.route.ts);
  dom.hero.dataset.state = deciding ? 'deciding' : rec ? 'decided' : 'empty';
  if (pending && deciding) {
    const turn = pending.turn ? `, message ${pending.turn}` : '';
    dom.classifying.textContent = `Jev is classifying a new prompt (session ${short(pending.session)}${turn})…`;
  }
  if (rec) renderDecision(rec);
  else if (deciding) {
    dom.catName.textContent = 'Classifying…';
    dom.catConf.textContent = '';
  }
}

/** @param {RouteRec} rec */
function announce(rec) {
  const { route } = rec;
  const jev = route.jev;
  const lead = jev?.ok ? `Jev: ${jev.choice}, ${pct(jev.probabilities[jev.choice])} sure.` : 'Jev not used.';
  dom.announce.textContent = `${lead} Routed to ${route.tier}, ${route.model}. Reason: ${route.reason}.`;
}

// ---------------------------------------------------------------------------------------------
// Timeline

/** @type {Map<string, HTMLElement>} */
const ghosts = new Map();

/** @param {DecidingEvent} ev */
function showGhost(ev) {
  dropGhost(ev.session);
  const li = h('li', 'ghost-row enter');
  const dot = h('i', 'dot');
  dot.style.setProperty('--h', String(hue(ev.session)));
  li.append(h('span', 'scan'), dot, h('span', '', `${short(ev.session)} · Jev is classifying the new prompt…`));
  dom.feed.prepend(li);
  ghosts.set(ev.session, li);
  dom.feedEmpty.hidden = true;
}

/** @param {string} session */
function dropGhost(session) {
  ghosts.get(session)?.remove();
  ghosts.delete(session);
}

/** @param {RouteRec} rec */
function kindLabel(rec) {
  const { route } = rec;
  if (isCount(route)) return 'count';
  if (route.reason === 'side-call' || route.kind === 'auxiliary') return 'background';
  if (route.kind && route.kind !== 'main') return route.kind;
  return rec.head ? 'prompt' : 'tool step';
}

/** @param {RouteRec} rec */
function fillResult(rec) {
  const cell = rec.cell;
  if (!cell) return;
  if (rec.error) {
    cell.replaceChildren(h('span', 'bad', rec.error.length > 48 ? `${rec.error.slice(0, 47)}…` : rec.error));
    cell.title = rec.error;
    return;
  }
  const done = rec.done;
  if (!done) {
    cell.replaceChildren(h('span', 'streaming', isCount(rec.route) ? 'counting' : 'streaming'));
    return;
  }
  const ok = done.status >= 200 && done.status < 300;
  /** @type {Array<string | HTMLElement>} */
  const parts = ok ? [dur(done.ms)] : [h('span', 'bad', String(done.status || '?')), ` · ${dur(done.ms)}`];
  const u = done.usage;
  if (u) parts.push(` · ${tokens(u.input)}/${tokens(u.output)}/${tokens(u.cacheRead)}`);
  if (done.cost !== undefined) parts.push(' · ', h('span', 'cost', money(done.cost)));
  cell.replaceChildren(...parts);
  cell.title = u ? `input ${u.input}, output ${u.output}, cache read ${u.cacheRead}, cache write ${u.cacheWrite} tokens` : '';
}

/**
 * @param {RouteRec} rec
 * @param {'div' | 'li'} tag
 */
function rowEl(rec, tag) {
  const { route } = rec;
  const row = h(tag, rec.head ? 'row head' : 'row');
  paint(row, route.tier);
  const sess = h('span', 'sess');
  const dot = h('i', 'dot');
  dot.style.setProperty('--h', String(hue(route.session)));
  sess.append(dot, short(route.session));
  const main = h('span', 'row-main');
  main.append(h('span', 'kind', kindLabel(rec)));
  if (route.jev?.ok) {
    const cat = h('span', 'cat', route.jev.choice);
    paint(cat, optionTier(route.jev.choice));
    cat.append(h('small', '', pct(route.jev.probabilities[route.jev.choice])));
    main.append(cat);
  }
  main.append(
    setReason(h('span', 'chip reason'), route.reason),
    chip(route.tier, route.tier),
    h('span', 'arrow', '→'),
    h('span', 'model', shortModel(route.model)),
  );
  const res = h('span', 'res');
  rec.cell = res;
  fillResult(rec);
  row.append(h('span', 't', clock(route.ts)), sess, main, res);
  row.title = `${route.model} on ${route.upstream || '?'}${route.trustedOnly ? ' · trusted only' : ''}`;
  if (rec.live && tag === 'li') row.classList.add('enter');
  return row;
}

/** @param {Group} group */
function orphanHead(group) {
  const row = h('div', 'row head orphan');
  const sess = h('span', 'sess');
  const dot = h('i', 'dot');
  dot.style.setProperty('--h', String(hue(group.session)));
  sess.append(dot, short(group.session));
  const first = group.steps[0];
  row.append(
    h('span', 't', first ? clock(first.route.ts) : ''),
    sess,
    h('span', 'row-main kind', 'requests before the first prompt the router saw'),
    h('span', 'res'),
  );
  return row;
}

/** @param {Group} group */
function mountGroup(group) {
  const li = h('li', 'group');
  if (group.live) li.classList.add('enter');
  paint(li, group.head?.route.tier);
  li.append(group.head ? rowEl(group.head, 'div') : orphanHead(group));
  const steps = h('ol', 'steps');
  li.append(steps);
  group.el = li;
  group.stepsEl = steps;
  let anchor = dom.feed.firstElementChild;
  while (anchor?.classList.contains('ghost-row')) anchor = anchor.nextElementSibling;
  dom.feed.insertBefore(li, anchor);
}

/** @param {Group} group */
function syncSteps(group) {
  const box = group.stepsEl;
  if (!box) return;
  while (group.shown < group.steps.length) {
    const rec = group.steps[group.shown];
    group.shown += 1;
    box.append(rowEl(rec, 'li'));
    const rows = box.querySelectorAll(':scope > li.row');
    if (rows.length > MAX_STEPS_SHOWN) {
      rows[0].remove();
      group.hidden += 1;
    }
  }
  if (group.hidden > 0) {
    if (!group.moreEl) {
      group.moreEl = h('li', 'more');
      box.prepend(group.moreEl);
    }
    group.moreEl.textContent = `… ${count(group.hidden, 'earlier request')}`;
  }
}

function renderFeed() {
  for (const group of state.groups) {
    if (!group.el) mountGroup(group);
    syncSteps(group);
  }
  for (const rec of dirtyRecs) fillResult(rec);
  dirtyRecs.clear();
  dom.feedEmpty.hidden = state.groups.length > 0 || ghosts.size > 0;
  const n = state.totals.requests;
  dom.feedNote.textContent = n ? count(n, 'request') : '';
}

// ---------------------------------------------------------------------------------------------
// Sessions

/** @typedef {{ li: HTMLElement, tier: HTMLElement, model: HTMLElement, spend: HTMLElement, stairs: HTMLElement, foot: HTMLElement, turns: number }} Lane */

/** @type {Map<string, Lane>} */
const lanes = new Map();

/** @param {Session} session */
function mountLane(session) {
  const li = h('li', 'lane enter');
  const head = h('div', 'lane-head');
  const dot = h('i', 'dot');
  dot.style.setProperty('--h', String(hue(session.id)));
  const tier = h('span', 'chip');
  const model = h('span', 'model');
  const spend = h('span', 'spend');
  head.append(dot, h('span', 'sess', short(session.id)), h('span', 'client', clientName(session.surface)), tier, model, spend);
  const stairs = h('div', 'stairs');
  stairs.setAttribute('aria-label', 'Tier per prompt');
  const foot = h('div', 'lane-foot');
  li.append(head, stairs, foot);
  /** @type {Lane} */
  const lane = { li, tier, model, spend, stairs, foot, turns: 0 };
  lanes.set(session.id, lane);
  return lane;
}

/** @param {string} tier */
function stairHeight(tier) {
  const tiers = state.config?.tiers ?? [...state.seenTiers].filter((t) => t !== 'side');
  const rank = tiers.indexOf(tier);
  if (rank < 0) return 22;
  return Math.round(22 + (78 * (rank + 1)) / Math.max(1, tiers.length));
}

/**
 * @param {Lane} lane
 * @param {Session} session
 */
function updateLane(lane, session) {
  lane.tier.textContent = session.tier || '–';
  paint(lane.tier, session.tier);
  paint(lane.li, session.tier);
  lane.model.textContent = session.model ? shortModel(session.model) : '';
  lane.spend.textContent = money(session.spend);
  const fresh = session.turnCount - lane.turns;
  const start = Math.max(0, session.turns.length - fresh);
  for (const turn of session.turns.slice(start)) {
    const stair = h('span', turn.live ? 'stair new' : 'stair');
    paint(stair, turn.tier);
    stair.style.setProperty('--hgt', `${stairHeight(turn.tier)}%`);
    stair.title = `${turn.choice || baseReason(turn.reason)} → ${turn.tier} → ${shortModel(turn.model)} (${turn.reason})`;
    lane.stairs.append(stair);
    if (lane.stairs.children.length > MAX_STAIRS) lane.stairs.firstElementChild?.remove();
  }
  lane.turns = session.turnCount;
  lane.foot.textContent = laneFoot(session);
}

function renderSessions() {
  const list = [...state.sessions.values()].sort((a, b) => b.last - a.last).slice(0, MAX_SESSIONS);
  const keep = new Set(list.map((x) => x.id));
  for (const [id, lane] of lanes) {
    if (keep.has(id)) continue;
    lane.li.remove();
    lanes.delete(id);
  }
  for (const [index, session] of list.entries()) {
    const lane = lanes.get(session.id) ?? mountLane(session);
    updateLane(lane, session);
    const at = dom.sessions.children[index];
    if (at !== lane.li) dom.sessions.insertBefore(lane.li, at ?? null);
  }
  dom.sessionsEmpty.hidden = list.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Totals

/** @type {Map<string, { box: HTMLElement, value: HTMLElement, sub: HTMLElement, last: string }>} */
const tiles = new Map();

/**
 * @param {string} key
 * @param {string} value
 * @param {string} sub
 * @param {string} [tone]
 */
function tile(key, value, sub, tone = '') {
  let t = tiles.get(key);
  if (!t) {
    const box = h('div', 'tile');
    const v = h('div', 'v');
    const s2 = h('div', 's');
    box.append(h('div', 'k', key), v, s2);
    dom.tiles.append(box);
    t = { box, value: v, sub: s2, last: '' };
    tiles.set(key, t);
  }
  t.box.className = tone ? `tile ${tone}` : 'tile';
  t.value.textContent = value;
  t.sub.textContent = sub;
  if (t.last && t.last !== value && !replaying) restartClass(t.box, 'bump', 520);
  t.last = value;
}

/** @param {number | undefined} saved */
function savingsTone(saved) {
  if (saved === undefined || Math.abs(saved) < 0.005) return '';
  return saved > 0 ? 'good' : 'bad';
}

function renderTotals() {
  const t = state.totals;
  const saved = t.baseline > 0 ? (t.baseline - t.spend) / t.baseline : undefined;
  tile('Requests', String(t.requests), count(state.models.size, 'model'));
  tile('Prompts', String(t.prompts), 'human turns');
  tile('Jev p50', t.jevMs.length ? dur(median(t.jevMs)) : '–', `${t.jevMs.length} answers`);
  tile('Fallbacks', String(t.fallbacks), 'Jev failures', t.fallbacks ? 'bad' : '');
  tile('Spend', money(t.spend), t.priced ? `baseline ${money(t.baseline)}` : 'no priced calls yet');
  tile('Saved', saved === undefined ? '–' : pct(saved), 'vs baseline', savingsTone(saved));
  dom.totalsNote.textContent = t.priced ? `${t.priced} priced calls` : '';
  const rows = [...state.models.entries()].sort((a, b) => b[1].spend - a[1].spend || b[1].count - a[1].count).slice(0, 6);
  const top = Math.max(...rows.map(([, m]) => m.spend), 1e-9);
  dom.mbars.replaceChildren(
    ...rows.map(([model, m]) => {
      const row = barRow(shortModel(model), false);
      paint(row.row, m.tier);
      row.row.classList.add('chosen');
      row.value.textContent = money(m.spend);
      row.row.title = `${model}: ${count(m.count, 'request')}, ${money(m.spend)}`;
      setWidth(row.fill, m.spend / top, false);
      return row.row;
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Flow graph

/**
 * @typedef {{ id: string, kind: 'client' | 'router' | 'option' | 'tier' | 'model', key: string, label: string, sub: string,
 *   tier: string, tip: string, x: number, y: number, w: number, h: number, g?: SVGGElement, subEl?: SVGTextElement,
 *   heat?: SVGRectElement }} GNode
 * @typedef {{ id: string, d: string, cls: string, tier: string, el?: SVGPathElement }} GEdge
 * @typedef {{ key: string, title: string, items: GNode[], x: number, w: number, top: number, height: number }} Column
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ nodes: Map<string, GNode>, edges: Map<string, GEdge>, columns: Column[], width: number, height: number,
 *   mode: string, entry: Point | undefined, jevBox?: SVGRectElement, particles?: SVGGElement }} Graph
 */

/** @type {Graph | undefined} */
let graph;
let graphWidth = 0;
const measure = document.createElement('canvas').getContext('2d');

/**
 * @param {string} text
 * @param {string} font
 */
function textWidth(text, font) {
  if (!measure) return text.length * 7.2;
  measure.font = font;
  return measure.measureText(text).width;
}

function shownSurfaces() {
  const configured = Object.keys(state.config?.surfaces ?? {});
  const primary = configured.includes('anthropic') ? ['anthropic'] : configured.slice(0, 1);
  const shown = uniq([...primary, ...state.seenSurfaces]);
  return shown.length ? shown : ['anthropic'];
}

function graphModel() {
  const cfg = state.config;
  const seenTiers = [...state.seenTiers].filter((t) => t !== 'side' && t !== 'trusted');
  const surfaces = shownSurfaces();
  const hasSide = state.seenTiers.has('side') || surfaces.some((surface) => cfg?.surfaces[surface]?.side);
  const tiers = uniq([...(cfg?.tiers ?? []), ...seenTiers, ...(hasSide ? ['side'] : [])]);
  const options = uniq([...Object.keys(cfg?.options ?? {}), ...state.seenOptions]);
  /** @type {Map<string, { tier: string, surface: string, upstream: string }>} */
  const models = new Map();
  /** @type {Set<string>} */
  const links = new Set();
  for (const surface of surfaces) {
    const targets = cfg?.surfaces[surface] ?? {};
    for (const tier of tiers) {
      const t = targets[tier];
      if (!t) continue;
      if (!models.has(t.model)) models.set(t.model, { tier, surface, upstream: t.upstream });
      links.add(`${tier}>${t.model}`);
    }
  }
  for (const [model, seen] of state.seenModels) {
    if (!surfaces.includes(seen.surface)) continue;
    if (!models.has(model)) models.set(model, { tier: seen.tier, surface: seen.surface, upstream: '' });
    if (tiers.includes(seen.tier) && seen.tier !== 'side') links.add(`${seen.tier}>${model}`);
  }
  return { tiers, options, surfaces, models, links };
}

/** @param {RouteRec} rec */
function graphHas(rec) {
  if (!graph) return false;
  const { route } = rec;
  const option = route.jev?.ok ? graph.nodes.has(`opt:${route.jev.choice}`) : true;
  return option && graph.nodes.has(`tier:${route.tier}`) && graph.nodes.has(`model:${route.model}`);
}

/**
 * @param {GNode['kind']} kind
 * @param {string} key
 * @param {string} label
 * @param {{ sub?: string, tier?: string, tip?: string, h: number }} opts
 * @returns {GNode}
 */
function gnode(kind, key, label, opts) {
  const prefix = { client: 'client:', router: '', option: 'opt:', tier: 'tier:', model: 'model:' }[kind];
  return {
    id: `${prefix}${key}`,
    kind,
    key,
    label,
    sub: opts.sub ?? '',
    tier: opts.tier ?? '',
    tip: opts.tip ?? label,
    x: 0,
    y: 0,
    w: 0,
    h: opts.h,
  };
}

/**
 * @param {GNode} n
 * @param {boolean} compact
 */
function nodeWidth(n, compact) {
  const label = textWidth(n.label, compact ? SMALL_LABEL_FONT : LABEL_FONT);
  if (n.kind === 'model') return Math.max(label, textWidth(compact ? '$0.000' : '000 req · streaming', MONO_FONT)) + (compact ? 22 : 28);
  if (n.kind === 'option') return label + (compact ? 36 : 48);
  if (n.kind === 'tier') return label + textWidth(n.sub || '', MONO_FONT) + (compact ? 22 : 34);
  return label + 26;
}

/**
 * @param {ReturnType<typeof graphModel>} m
 * @param {string} mode
 * @returns {Column[]}
 */
function graphColumns(m, mode) {
  const compact = mode === 'compact';
  const rowH = mode === 'full' ? 32 : 28;
  const modelH = compact ? 36 : 40;
  const accept = state.config?.accept ?? {};
  /** @type {Array<[string, string, GNode[]]>} */
  const cols = [];
  if (mode === 'full') cols.push(['client', 'Client', m.surfaces.map((x) => gnode('client', x, clientName(x), { h: rowH }))]);
  if (mode !== 'compact')
    cols.push([
      'router',
      'Router',
      [gnode('router', 'router', 'jev-router', { h: rowH, tip: `jev-router · ${state.config?.mode || 'ratchet'} mode` })],
    ]);
  cols.push([
    'option',
    'Jev category',
    m.options.map((o) => gnode('option', o, o, { tier: optionTier(o), h: rowH, tip: `${o} → ${optionTier(o) ?? '?'}` })),
  ]);
  cols.push([
    'tier',
    'Tier',
    m.tiers.map((t) =>
      gnode('tier', t, t, {
        tier: t,
        h: rowH,
        sub: compact || accept[t] === undefined ? '' : `≥${pct(accept[t])}`,
        tip: `${t}: accepted at ${pct(accept[t])}`,
      }),
    ),
  ]);
  cols.push([
    'model',
    'Model',
    [...m.models].map(([model, x]) =>
      gnode('model', model, shortModel(model), { tier: x.tier, h: modelH, tip: `${model}${x.upstream ? ` on ${x.upstream}` : ''}` }),
    ),
  ]);
  return cols.map(([key, title, items]) => ({
    key,
    title,
    items,
    x: 0,
    w: Math.max(...items.map((n) => nodeWidth(n, compact)), 60),
    top: 0,
    height: 0,
  }));
}

/**
 * @param {Point} a
 * @param {Point} b
 */
function curve(a, b) {
  const dx = Math.max(16, (b.x - a.x) * 0.5);
  const r = (/** @type {number} */ v) => Math.round(v * 10) / 10;
  return `M${r(a.x)} ${r(a.y)}C${r(a.x + dx)} ${r(a.y)} ${r(b.x - dx)} ${r(b.y)} ${r(b.x)} ${r(b.y)}`;
}

/**
 * The path that skips Jev: under the category column, then up into the tier.
 * @param {Point} a
 * @param {Column} col
 * @param {number} lane
 * @param {Point} b
 */
function bypass(a, col, lane, b) {
  const k = 22;
  const x1 = col.x - 4;
  const x2 = col.x + col.w + 4;
  return `M${a.x} ${a.y}C${a.x + k} ${a.y} ${x1 - k} ${lane} ${x1} ${lane}L${x2} ${lane}C${x2 + k} ${lane} ${b.x - k} ${b.y} ${b.x} ${b.y}`;
}

/** @param {GNode} n */
const leftOf = (n) => ({ x: n.x, y: n.y + n.h / 2 });
/** @param {GNode} n */
const rightOf = (n) => ({ x: n.x + n.w, y: n.y + n.h / 2 });

/**
 * @param {Column[]} cols
 * @param {number} width
 * @param {string} mode
 */
function placeColumns(cols, width, mode) {
  const padX = 10;
  const top = 30;
  const gapY = mode === 'full' ? 11 : 8;
  const entryLane = mode === 'compact' ? 16 : 0;
  const sum = cols.reduce((acc, c) => acc + c.w, 0);
  const minGap = mode === 'compact' ? 18 : 34;
  const gap = Math.max(minGap, (width - 2 * padX - entryLane - sum) / Math.max(1, cols.length - 1));
  const total = Math.max(width, 2 * padX + entryLane + sum + gap * (cols.length - 1));
  for (const c of cols) c.height = c.items.reduce((acc, n) => acc + n.h, 0) + gapY * Math.max(0, c.items.length - 1);
  const content = Math.max(...cols.map((c) => c.height), 64);
  let x = padX + entryLane;
  for (const c of cols) {
    c.x = x;
    c.top = top + (content - c.height) / 2;
    let y = c.top;
    for (const n of c.items) {
      n.x = x;
      n.y = y;
      n.w = c.w;
      y += n.h + gapY;
    }
    x += c.w + gap;
  }
  return { total, top, content, bottom: 34 };
}

/** @typedef {(from: string, to: string, d: string, cls: string, tier: string) => void} AddEdge */

/**
 * Router → category → tier, plus the bypass from the router straight to each tier.
 * @param {Map<string, GNode>} nodes
 * @param {{ point: Point, id: string }} source
 * @param {Column | undefined} optionCol
 * @param {number} lane
 * @param {AddEdge} edge
 */
function jevEdges(nodes, source, optionCol, lane, edge) {
  for (const n of nodes.values()) {
    if (n.kind === 'option') {
      edge(source.id, n.id, curve(source.point, leftOf(n)), 'edge', '');
      const tier = nodes.get(`tier:${optionTier(n.key) ?? ''}`);
      if (tier) edge(n.id, tier.id, curve(rightOf(n), leftOf(tier)), 'edge map', tier.key);
    } else if (n.kind === 'tier' && optionCol) {
      edge(source.id, n.id, bypass(source.point, optionCol, lane, leftOf(n)), 'edge bypass', n.key);
    }
  }
}

/**
 * Client → router, and tier → model for every target of the shown surfaces.
 * @param {ReturnType<typeof graphModel>} m
 * @param {Map<string, GNode>} nodes
 * @param {AddEdge} edge
 */
function outerEdges(m, nodes, edge) {
  const router = nodes.get('router');
  for (const surface of router ? m.surfaces : []) {
    const client = nodes.get(`client:${surface}`);
    if (client && router) edge(client.id, router.id, curve(rightOf(client), leftOf(router)), 'edge', '');
  }
  for (const link of m.links) {
    const [tierKey, model] = link.split('>');
    const tier = nodes.get(`tier:${tierKey}`);
    const target = nodes.get(`model:${model}`);
    if (tier && target) edge(tier.id, target.id, curve(rightOf(tier), leftOf(target)), 'edge map', tierKey);
  }
}

/**
 * The richest layout that fits the width: client, router, categories, tiers and models when
 * there is room, then without the client column, then a compact graph from the categories on.
 * @param {ReturnType<typeof graphModel>} m
 * @param {number} width
 */
function fitColumns(m, width) {
  for (const mode of ['full', 'medium']) {
    const columns = graphColumns(m, mode);
    const box = placeColumns(columns, width, mode);
    if (box.total <= width) return { mode, columns, box };
  }
  const columns = graphColumns(m, 'compact');
  return { mode: 'compact', columns, box: placeColumns(columns, width, 'compact') };
}

/**
 * @param {ReturnType<typeof graphModel>} m
 * @param {number} width
 * @returns {Graph}
 */
function layoutGraph(m, width) {
  const { mode, columns, box } = fitColumns(m, width);
  /** @type {Map<string, GNode>} */
  const nodes = new Map();
  for (const c of columns) for (const n of c.items) nodes.set(n.id, n);
  /** @type {Map<string, GEdge>} */
  const edges = new Map();
  /** @type {AddEdge} */
  const edge = (from, to, d, cls, tier) => {
    edges.set(`${from}>${to}`, { id: `${from}>${to}`, d, cls, tier });
  };
  const router = nodes.get('router');
  const entry = router ? undefined : { x: 14, y: box.top + box.content / 2 };
  const source = router ? { point: rightOf(router), id: 'router' } : { point: { x: 14, y: box.top + box.content / 2 }, id: 'entry' };
  jevEdges(
    nodes,
    source,
    columns.find((c) => c.key === 'option'),
    box.top + box.content + 16,
    edge,
  );
  outerEdges(m, nodes, edge);
  return { nodes, edges, columns, width: box.total, height: box.top + box.content + box.bottom, mode, entry };
}

/**
 * @param {GNode} n
 * @param {Graph} g
 */
function nodeEl(n, g) {
  const el = s('g', { class: `node ${n.kind}`, transform: `translate(${n.x} ${n.y})` });
  paint(el, n.tier || undefined);
  const title = s('title');
  title.textContent = n.tip;
  el.append(
    title,
    s('rect', { class: 'box', width: n.w, height: n.h, rx: 9 }),
    s('rect', { class: 'flash', width: n.w, height: n.h, rx: 9 }),
  );
  if (n.kind === 'option' || n.kind === 'tier') {
    n.heat = s('rect', { class: 'heat', x: 1.5, y: 1.5, width: Math.max(0, n.w - 3), height: n.h - 3, rx: 8 });
    el.append(n.heat);
  }
  const bar = n.kind === 'tier' ? state.config?.accept[n.key] : undefined;
  if (bar !== undefined) {
    const x = 1.5 + (n.w - 3) * bar;
    el.append(s('line', { class: 'thr', x1: x, x2: x, y1: n.h - 7, y2: n.h - 2.5 }));
  }
  const compact = g.mode === 'compact';
  const labelClass = compact ? 'label small' : 'label';
  if (n.kind === 'model') {
    el.append(svgText(n.label, 11, compact ? 15 : 17, labelClass));
    n.subEl = svgText('', 11, compact ? 29 : 32, 'sub');
    el.append(n.subEl);
  } else {
    el.append(svgText(n.label, 11, n.h / 2 + 4.5, labelClass));
    if (n.kind === 'option' || n.sub) {
      n.subEl = svgText(n.sub, n.w - 10, n.h / 2 + 4, n.kind === 'option' ? 'num' : 'sub');
      n.subEl.setAttribute('text-anchor', 'end');
      el.append(n.subEl);
    }
  }
  n.g = el;
  return el;
}

function buildGraph() {
  const width = Math.max(300, Math.floor(dom.flowWrap.clientWidth));
  graphWidth = width;
  clearParticles();
  const g = layoutGraph(graphModel(), width);
  const svg = dom.flow;
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${g.width} ${g.height}`);
  svg.setAttribute('width', String(g.width));
  svg.setAttribute('height', String(g.height));
  svg.setAttribute('class', `flow-svg ${g.mode}`);
  const back = s('g');
  const edgeLayer = s('g');
  const nodeLayer = s('g');
  const particles = s('g');
  for (const c of g.columns) back.append(svgText(c.title, c.x, 14, 'col-label'));
  const optionCol = g.columns.find((c) => c.key === 'option');
  if (optionCol) {
    g.jevBox = s('rect', {
      class: 'jevbox',
      x: optionCol.x - 7,
      y: optionCol.top - 7,
      width: optionCol.w + 14,
      height: optionCol.height + 14,
      rx: 13,
    });
    back.append(g.jevBox);
  }
  if (g.entry)
    back.append(s('line', { class: 'entry-rail', x1: g.entry.x - 6, x2: g.entry.x - 6, y1: g.entry.y - 22, y2: g.entry.y + 22 }));
  for (const e of g.edges.values()) {
    e.el = s('path', { d: e.d, class: e.cls });
    e.el.dataset.tier = e.tier;
    paint(e.el, e.tier || undefined);
    edgeLayer.append(e.el);
  }
  for (const n of g.nodes.values()) nodeLayer.append(nodeEl(n, g));
  if (![...g.nodes.values()].some((n) => n.kind === 'tier')) {
    const note = svgText("The graph appears with the router's config line or its first request.", g.width / 2, g.height / 2 + 4, 'sub');
    note.setAttribute('text-anchor', 'middle');
    back.append(note);
  }
  svg.append(back, edgeLayer, nodeLayer, particles);
  g.particles = particles;
  graph = g;
}

/**
 * @param {GNode} n
 * @param {number | undefined} p
 * @param {boolean} active
 */
function setHeat(n, p, active) {
  n.heat?.style.setProperty('--p', String(Math.max(0, Math.min(1, p ?? 0))));
  n.g?.classList.toggle('active', active);
  if (n.kind === 'option' && n.subEl) n.subEl.textContent = p === undefined ? '' : pct(p);
}

/**
 * @param {ModelStat | undefined} stat
 * @param {boolean} compact
 */
function modelSub(stat, compact) {
  if (!stat) return 'idle';
  const live = stat.inflight > 0;
  if (compact) return live ? 'live' : money(stat.spend);
  return `${stat.count} req · ${live ? 'streaming' : money(stat.spend)}`;
}

/**
 * @param {GNode} n
 * @param {RouteRec | undefined} latest
 */
function setModel(n, latest) {
  const stat = state.models.get(n.key);
  const compact = graph?.mode === 'compact';
  if (n.subEl) n.subEl.textContent = modelSub(stat, compact);
  n.g?.classList.toggle('busy', (stat?.inflight ?? 0) > 0);
  n.g?.classList.toggle('active', latest?.route.model === n.key);
}

function renderGraphState() {
  if (!graph) return;
  const latest = state.latest;
  const jev = latest?.route.jev?.ok ? latest.route.jev : undefined;
  for (const n of graph.nodes.values()) {
    if (n.kind === 'option') setHeat(n, jev?.probabilities[n.key], jev?.choice === n.key);
    else if (n.kind === 'tier') setHeat(n, jev?.tiers[n.key], latest?.route.tier === n.key);
    else if (n.kind === 'model') setModel(n, latest);
    else if (n.kind === 'client') n.g?.classList.toggle('dim', state.seenSurfaces.size > 0 && !state.seenSurfaces.has(n.key));
  }
  graph.jevBox?.classList.toggle('thinking', state.pending.size > 0);
}

// Particles: one per new request, hopping node to node along the route it took.

/** @typedef {{ el: SVGPathElement, len: number, dur: number, to: string, tier: string, ghost: boolean }} Segment */
/** @typedef {{ segs: Segment[], i: number, start: number, g: SVGGElement, halo: SVGCircleElement, core: SVGCircleElement }} Particle */

/** @type {Set<Particle>} */
const particles = new Set();
let particleFrame = 0;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function clearParticles() {
  particles.clear();
  if (particleFrame) cancelAnimationFrame(particleFrame);
  particleFrame = 0;
}

/**
 * @param {Graph} g
 * @param {string} from
 * @param {string} to
 * @param {string} tier
 * @returns {Segment | undefined}
 */
function segment(g, from, to, tier) {
  const target = g.nodes.get(to);
  if (!target) return undefined;
  const known = g.edges.get(`${from}>${to}`);
  let el = known?.el;
  if (!el) {
    const node = g.nodes.get(from);
    const a = from === 'entry' ? g.entry : node && rightOf(node);
    if (!a) return undefined;
    el = s('path', { d: curve(a, leftOf(target)), class: 'edge ghost' });
    paint(el, tier);
    g.particles?.prepend(el);
  }
  const len = el.getTotalLength();
  return { el, len, dur: Math.max(180, Math.min(620, len / 0.55)), to, tier, ghost: !known };
}

/** @param {RouteRec} rec */
function routeChain(rec) {
  if (!graph) return [];
  const { route } = rec;
  /** @type {string[]} */
  const chain = [];
  if (graph.mode === 'full') chain.push(`client:${rec.surface}`);
  chain.push(graph.mode === 'compact' ? 'entry' : 'router');
  if (route.jev?.ok) chain.push(`opt:${route.jev.choice}`);
  chain.push(`tier:${route.tier}`, `model:${route.model}`);
  const g = graph;
  return chain.filter((id) => id === 'entry' || g.nodes.has(id));
}

/** @param {string} id */
function flashNode(id) {
  const n = graph?.nodes.get(id);
  if (n?.g) restartClass(n.g, 'hit', 850);
}

/** @type {WeakMap<Element, ReturnType<typeof setTimeout>>} */
const paintTimers = new WeakMap();

/**
 * Lights the edge a particle just crossed in the route's tier color, then restores its own.
 * @param {Segment} seg
 */
function arrive(seg) {
  flashNode(seg.to);
  if (seg.ghost) return;
  const el = seg.el;
  paint(el, seg.tier);
  restartClass(el, 'lit', 700);
  clearTimeout(paintTimers.get(el));
  paintTimers.set(
    el,
    setTimeout(() => paint(el, el.dataset.tier || undefined), 1100),
  );
}

/** @param {Particle} p */
function finish(p) {
  p.g.remove();
  particles.delete(p);
  for (const seg of p.segs) {
    if (!seg.ghost) continue;
    seg.el.classList.add('gone');
    setTimeout(() => seg.el.remove(), 700);
  }
}

/**
 * @param {Particle} p
 * @param {number} now
 */
function advance(p, now) {
  let seg = p.segs[p.i];
  let t = (now - p.start) / seg.dur;
  while (t >= 1) {
    arrive(seg);
    p.i += 1;
    p.start += seg.dur;
    if (p.i >= p.segs.length) {
      finish(p);
      return;
    }
    seg = p.segs[p.i];
    t = (now - p.start) / seg.dur;
  }
  const eased = (1 - Math.cos(Math.PI * Math.max(0, t))) / 2;
  const point = seg.el.getPointAtLength(seg.len * eased);
  for (const c of [p.halo, p.core]) {
    c.setAttribute('cx', point.x.toFixed(1));
    c.setAttribute('cy', point.y.toFixed(1));
  }
}

/** @param {number} now */
function animate(now) {
  particleFrame = 0;
  for (const p of particles) advance(p, now);
  if (particles.size) particleFrame = requestAnimationFrame(animate);
}

/** @param {RouteRec} rec */
function animateRoute(rec) {
  if (!graph?.particles || document.hidden) return;
  const chain = routeChain(rec);
  if (reducedMotion.matches) {
    for (const id of chain) flashNode(id);
    return;
  }
  if (particles.size >= MAX_PARTICLES) return;
  const g = graph;
  /** @type {Segment[]} */
  const segs = [];
  for (let i = 0; i < chain.length - 1; i += 1) {
    const seg = segment(g, chain[i], chain[i + 1], rec.route.tier);
    if (seg) segs.push(seg);
  }
  if (!segs.length) return;
  const small = !rec.head;
  const group = s('g', { class: small ? 'particle small' : 'particle' });
  paint(group, rec.route.tier);
  const halo = s('circle', { class: 'halo', r: small ? 6 : 11, cx: -50, cy: -50 });
  const core = s('circle', { class: 'core', r: small ? 2.6 : 4.4, cx: -50, cy: -50 });
  group.append(halo, core);
  g.particles?.append(group);
  particles.add({ segs, i: 0, start: performance.now(), g: group, halo, core });
  if (chain[0]) flashNode(chain[0]);
  if (!particleFrame) particleFrame = requestAnimationFrame(animate);
}

// ---------------------------------------------------------------------------------------------
// Toasts and the render loop

/**
 * @param {string} text
 * @param {'info' | 'warn' | 'error'} level
 */
function toast(text, level) {
  const el = h('div', level === 'info' ? 'toast' : `toast ${level}`, text);
  el.setAttribute('role', level === 'error' ? 'alert' : 'status');
  dom.toasts.append(el);
  while (dom.toasts.children.length > 4) dom.toasts.firstElementChild?.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 5200);
}

/** @type {Set<string>} */
const dirty = new Set();
/** @type {RouteRec[]} */
const queuedParticles = [];
let frame = 0;

/** @param {...string} parts */
function schedule(...parts) {
  for (const part of parts) dirty.add(part);
  if (!frame && !replaying) frame = requestAnimationFrame(flush);
}

function flush() {
  frame = 0;
  const parts = new Set(dirty);
  dirty.clear();
  if (parts.has('layout') || !graph) buildGraph();
  for (const rec of queuedParticles.splice(0)) animateRoute(rec);
  if (parts.has('header') || parts.has('layout')) renderHeader();
  if (parts.has('hero')) renderHero();
  if (parts.has('feed')) renderFeed();
  renderGraphState();
  if (parts.has('sessions')) renderSessions();
  if (parts.has('totals')) renderTotals();
}

function resetView() {
  clearParticles();
  queuedParticles.length = 0;
  graph = undefined;
  dom.feed.replaceChildren();
  ghosts.clear();
  lanes.clear();
  dom.sessions.replaceChildren();
  tiles.clear();
  dom.tiles.replaceChildren();
  dirtyRecs.clear();
  dom.bars.dataset.key = '';
  dom.tierbars.dataset.key = '';
}

/** @param {string} data */
function loadSnapshot(data) {
  const snap = parse(data);
  const events = isObj(snap) && Array.isArray(snap.events) ? snap.events : [];
  state = freshState();
  resetView();
  state.file = isObj(snap) ? str(snap.file) : '';
  replaying = true;
  for (const raw of events) {
    const ev = normalize(raw);
    if (ev) apply(ev, false);
  }
  replaying = false;
  prunePending();
  schedule('layout', 'header', 'hero', 'feed', 'sessions', 'totals');
}

function connect() {
  const source = new EventSource('/events');
  source.addEventListener('open', () => setConnection('live'));
  source.addEventListener('error', () => {
    if (source.readyState !== EventSource.CLOSED) {
      setConnection('reconnecting');
      return;
    }
    setConnection('closed');
    setTimeout(connect, 3000);
  });
  source.addEventListener('snapshot', (event) => loadSnapshot(event.data));
  source.addEventListener('message', (event) => {
    const ev = normalize(parse(event.data));
    if (ev) apply(ev, true);
  });
}

function tick() {
  prunePending();
  const latest = state.latest;
  if (latest) dom.heroWhen.textContent = `${clock(latest.route.ts)} · ${ago(latest.route.ts)}`;
  for (const [id, lane] of lanes) {
    const session = state.sessions.get(id);
    if (session) lane.foot.textContent = laneFoot(session);
  }
}

function init() {
  const resize = new ResizeObserver(() => {
    if (Math.abs(Math.floor(dom.flowWrap.clientWidth) - graphWidth) > 8) schedule('layout');
  });
  resize.observe(dom.flowWrap);
  setInterval(tick, 1000);
  schedule('layout', 'header', 'hero', 'feed', 'sessions', 'totals');
  connect();
}

init();
