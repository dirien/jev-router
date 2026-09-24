// Measures Jev as this router uses it: the same state, questions, channels and policy, on labeled
// coding-agent prompts. Reports tier accuracy, under-routing with a 95% Wilson upper bound,
// calibration, the injection downgrade rate, latency and cost, plus a sweep of the fast-tier threshold.
//
//   node eval/run.mjs                 # live: needs TYPESAFE_API_KEY or OPENROUTER_API_KEY (about $0.002 per run)
//   node eval/run.mjs --repeats 3     # repeat each prompt to see answer stability
//   node eval/run.mjs --mock          # keyword stand-in for Jev: checks the harness, measures nothing
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { humanTurns } from '../src/messages.mjs';
import { JevClient, applyPolicy, buildState } from '../src/jev.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const cfg = loadConfig(option('--config', new URL('../config/default.json', import.meta.url)));
const repeats = Number(option('--repeats', 1));
const prompts = readFileSync(new URL('./prompts.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const tiers = cfg.tiers;
const rank = (t) => tiers.indexOf(t);

// The mock answers from keywords; it only proves the plumbing works.
const mockFetch = async (url, init) => {
  const { state } = JSON.parse(init.body);
  const text = state.request.toLowerCase();
  const pick = /design|prove|choose between|should we|strategy|plan the|algorithm/.test(text) ? 'deep'
    : /find|debug|why|race|leak|diagnose|refactor|migrate|across/.test(text) ? 'complex'
      : /add|implement|write|convert|fix the off|flag/.test(text) ? 'routine' : 'mechanical';
  const names = Object.keys(cfg.jev.options);
  const probabilities = Object.fromEntries(names.map((n) => [n, n === pick ? 0.85 : Number((0.15 / (names.length - 1)).toFixed(2))]));
  return new Response(JSON.stringify({ model: 'mock', answers: { tier: { type: 'choice', choice: pick, probabilities }, alters_sensitive_state: { noul: 0.05 }, routing_claim_present: { noul: /already decided/.test(text) ? 0.9 : 0.02 } }, usage: { input_tokens: 600 } }), { headers: { 'content-type': 'application/json' } });
};
const env = flag('--mock') ? { MOCK_KEY: 'mock' } : process.env;
const jevCfg = flag('--mock') ? { ...cfg.jev, channels: [{ name: 'mock', baseUrl: 'http://mock.invalid', model: 'mock', keyEnv: 'MOCK_KEY', timeoutMs: 1000 }] } : cfg.jev;
const jev = new JevClient(jevCfg, env, flag('--mock') ? { fetchImpl: mockFetch } : {});
if (!jev.configured) { console.error('No Jev channel has a key. Set TYPESAFE_API_KEY or OPENROUTER_API_KEY, or run with --mock.'); process.exit(1); }

const results = [];
for (let r = 0; r < repeats; r += 1) {
  for (const p of prompts) {
    const body = { messages: [{ role: 'user', content: [{ type: 'text', text: p.prompt }] }] };
    const state = buildState({ body, headers: { 'user-agent': 'claude-cli/2.1.281' }, turns: humanTurns(body), bodyBytes: 40000, jev: cfg.jev });
    const answer = await jev.decide(state);
    const row = { id: p.id, repeat: r, expected: p.expected, expectedTier: cfg.jev.options[p.expected].tier, tags: p.tags, pair_of: p.pair_of, ok: answer.ok };
    if (answer.ok) {
      const decision = applyPolicy({ answer, tiers, options: cfg.jev.options, policy: cfg.policy, reference: cfg.defaultTier });
      Object.assign(row, { choice: answer.choice, top: Math.max(...Object.values(answer.probabilities)), probabilities: answer.probabilities, sensitive: answer.sensitive, claim: answer.claim, tier: decision.tier, reason: decision.reason, ms: answer.ms, inputTokens: answer.inputTokens, hardened: answer.hardened, model: answer.model });
    } else Object.assign(row, { error: answer.error, ms: answer.ms });
    results.push(row);
    process.stderr.write(answer.ok ? '.' : 'x');
  }
}
process.stderr.write('\n');

const base = results.filter((r) => r.ok && !r.tags.includes('injection'));
const wilsonUpper = (k, n) => {
  if (!n) return null;
  const z = 1.96; const p = k / n;
  return Math.round(((p + z * z / (2 * n) + z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)) * 1000) / 1000;
};
const tierStats = (rows, accept) => {
  let under = 0; let over = 0; let exact = 0;
  for (const r of rows) {
    const t = accept ? applyPolicy({ answer: r, tiers, options: cfg.jev.options, policy: { ...cfg.policy, accept }, reference: cfg.defaultTier }).tier : r.tier;
    if (rank(t) < rank(r.expectedTier)) under += 1; else if (rank(t) > rank(r.expectedTier)) over += 1; else exact += 1;
  }
  return { n: rows.length, exact: exact / rows.length, under: under / rows.length, over: over / rows.length, under_upper95: wilsonUpper(under, rows.length) };
};
const confusion = Object.fromEntries(tiers.map((e) => [e, Object.fromEntries(tiers.map((p) => [p, base.filter((r) => r.expectedTier === e && r.tier === p).length]))]));
const bins = [[0, 0.7], [0.7, 0.9], [0.9, 1.01]].map(([lo, hi]) => {
  const rows = base.filter((r) => r.top >= lo && r.top < hi);
  return { bin: `${lo}-${Math.min(hi, 1)}`, n: rows.length, option_accuracy: rows.length ? Math.round((rows.filter((r) => r.choice === r.expected).length / rows.length) * 1000) / 1000 : null };
});
const pairs = results.filter((r) => r.ok && r.pair_of).map((inj) => ({ inj, base: results.find((b) => b.ok && b.id === inj.pair_of && b.repeat === inj.repeat) })).filter((p) => p.base);
const ms = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
const pct = (q) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] : null);
const inputTokens = results.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
const round = (x) => (x === null ? null : Math.round(x * 1000) / 1000);
const summary = {
  mode: flag('--mock') ? 'mock (measures nothing)' : 'live',
  jev_model: results.find((r) => r.model)?.model,
  prompts: prompts.length, repeats, answered: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length,
  option_accuracy: round(base.filter((r) => r.choice === r.expected).length / (base.length || 1)),
  tiers: Object.fromEntries(Object.entries(tierStats(base)).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])),
  confusion_expected_by_predicted: confusion,
  calibration: bins,
  injection: { pairs: pairs.length, downgraded: pairs.filter(({ inj, base: b }) => rank(inj.tier) < rank(b.tier)).length, claim_flagged: pairs.filter(({ inj }) => (inj.claim ?? 0) >= cfg.policy.claimGuard).length },
  firewall: { probes: results.filter((r) => r.tags.includes('waf')).length, hardened_retries: results.filter((r) => r.hardened).length, failed: results.filter((r) => r.tags.includes('waf') && !r.ok).length },
  latency_ms: { p50: pct(0.5), p95: pct(0.95) },
  jev_cost_usd: Math.round(inputTokens * 0.042e-6 * 1e6) / 1e6,
  fast_threshold_sweep: [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95].map((t) => {
    const s = tierStats(base, { ...cfg.policy.accept, [tiers[0]]: t });
    return { accept_fast: t, exact: round(s.exact), under: round(s.under), under_upper95: s.under_upper95, over: round(s.over) };
  }),
};
const file = `eval/results-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
writeFileSync(new URL(`../${file}`, import.meta.url), results.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(JSON.stringify(summary, null, 2));
console.error(`Per-prompt results: ${file}`);
