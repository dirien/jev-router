// Live check against api.anthropic.com with Jev mocked. Three requests with max_tokens 32.
// Run: npm run test:live   (needs Anthropic credentials: ANTHROPIC_API_KEY, or a proxy that injects them)

import { readFileSync } from 'node:fs';
import { validateConfig } from '../src/config.mjs';
import { createRouter } from '../src/router.mjs';
import {
  claudeCodeBody,
  claudeCodeHeaders,
  claudeCodeToolTurn,
  close,
  jevOptionsAnswer,
  json,
  listen,
  mockServer,
  sha256,
} from './helpers.mjs';

const plan = { option: 'mechanical', probability: 0.95 };
const jev = await mockServer((call, res) => json(res, 200, jevOptionsAnswer(plan)));
const cfg = JSON.parse(readFileSync(new URL('../config/anthropic-only.json', import.meta.url), 'utf8'));
cfg.jev.channels = [{ name: 'mock', baseUrl: jev.url, model: 'jev-1.13.0', keyEnv: 'MOCK_JEV_KEY', timeoutMs: 1000 }];
const logs = [];
const server = createRouter(validateConfig({ ...cfg, stateFile: null }), {
  env: { ...process.env, MOCK_JEV_KEY: 'mock' },
  log: (e) => logs.push(e),
});
const url = await listen(server);
const headers = (s) =>
  claudeCodeHeaders(s, {
    'x-claude-code-request-class': 'main',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,effort-2025-11-24',
  });
delete headers('x')['x-api-key'];
const opus = (s, text, extra = {}) => ({
  ...claudeCodeBody(s, text, { model: 'claude-opus-5-5', maxTokens: 32 }),
  thinking: { type: 'adaptive' },
  output_config: { effort: 'high' },
  context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
  ...extra,
});
const results = [];
async function send(label, body, hdrs) {
  const h = { ...hdrs };
  delete h['x-api-key'];
  const res = await fetch(`${url}/v1/messages?beta=true`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const bytes = Buffer.from(await res.arrayBuffer());
  const done = logs.filter((e) => e.event === 'done').at(-1);
  const route = logs.filter((e) => e.event === 'route').at(-1);
  results.push({
    label,
    status: res.status,
    tier: res.headers.get('x-jev-tier'),
    model: route?.model,
    reason: route?.reason,
    sha_match: done?.sha256 === sha256(bytes),
    usage: done?.usage,
    cost_usd: done?.cost_usd,
    error: res.status >= 400 ? bytes.toString().slice(0, 160) : undefined,
  });
}
const s1 = crypto.randomUUID();
await send('1 haiku, full Claude Code field set', opus(s1, 'What does ls -la print? One sentence.'), headers(s1));
const loop = {
  ...claudeCodeToolTurn(s1, 'What does ls -la print? One sentence.'),
  model: 'claude-opus-5-5',
  max_tokens: 32,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'high' },
  context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
};
await send('2 haiku, tool-loop turn (sticky)', loop, headers(s1));
plan.option = 'routine';
const s2 = crypto.randomUUID();
await send('3 sonnet 5, full field set', opus(s2, 'Add a unit test for the parser. Reply with one word.'), headers(s2));
console.log(JSON.stringify(results, null, 2));
console.log('jev mock calls:', jev.calls.length, '(expect 2)');
await close(server);
await jev.close();
