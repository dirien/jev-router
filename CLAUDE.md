<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-09-24 | Last verified: 2026-09-24 -->

# AGENTS.md

**Precedence:** the **closest `AGENTS.md`** to the files you're changing wins. This is the only one in the repo.
`CLAUDE.md` is an identical copy for Claude Code; keep the two files the same.

## Project

jev-router is a local pass-through model router for Claude Code (Anthropic Messages) and the Codex CLI (OpenAI
Responses). On each new human message it asks Jev, TypeSafe AI's System One decision model, which tier the work
needs, and routes the session to a fast, balanced or frontier model. Dependency-free Node ESM (`.mjs`, Node >= 22).
No build step and no bundler: TypeScript only type-checks the JSDoc.

| Fact | Value |
| --- | --- |
| Entry point | `bin/jev-router.mjs` calls `main(argv)` in `src/cli.mjs` |
| Server | `createRouter`, `describeConfig`, `report` and `VERSION` in `src/router.mjs` |
| Live view | `serve --ui [<host>:]<port>` feeds `createUiServer` (`src/ui.mjs`) in-process through `publish`; `jev-router ui [log]` feeds it with `LogTail` from a log file. It serves `ui/` (`index.html`, `app.css`, `app.js`) plus server-sent events, on `127.0.0.1:4100` by default. `ui/tsconfig.json` type-checks the browser code |
| Modules | `src/config.mjs` defaults and validation; `src/jev.mjs` state, questions, channels, policy; `src/messages.mjs` human turns, wrapper tags, tier tags; `src/secrets.mjs` scanner and redaction; `src/sessions.mjs` persistent store; `src/usage.mjs` usage tap and prices; `src/ui.mjs` live view server |
| Configs | `config/default.json`, `config/anthropic-only.json`. Lookup: `--config`, `JEV_ROUTER_CONFIG`, `$XDG_CONFIG_HOME/jev-router/config.json`, then `config/default.json` |
| Endpoints | `POST /v1/messages`, `POST /v1/messages/count_tokens`, `POST /v1/responses`, `GET /healthz`; `127.0.0.1:4000` by default |
| Runtime state | `~/.local/state/jev-router/sessions.jsonl` (hashed session keys, no prompt text, mode 0600) |
| Evaluation | `eval/run.mjs` over `eval/prompts.jsonl` (58 labeled prompts); results go to `eval/results-*.jsonl`, which git ignores |
| Client examples | `examples/claude-code.env`, `examples/codex/jev.config.toml`, `examples/codex/jev-models.json` (carries Codex's Apache-2.0 system prompt, credited in `NOTICE`) |
| Sandbox kit | `sbx/jev-router-kit/spec.yaml` |
| Docs | `README.md` (users), `docs/activation.md`, `docs/configuration.md`, `docs/design.md` (why), `docs/evaluation.md`, `docs/sandbox.md`, `CHANGELOG.md` |
| Version | `1.3.2`, in `package.json` and in `VERSION` (`src/router.mjs`) |

## Commands (verified 2026-09-24)

> Source: `package.json` scripts. CI runs `npm ci` and `npm run check` on ubuntu-latest with Node 22 and 24, and
> actionlint on the workflows.

<!-- AGENTS-GENERATED:START commands -->
| Task | Command | ~Time |
| --- | --- | --- |
| Install dev tools | `npm ci` | ~5s |
| Lint and format check (Biome) | `npm run lint` | ~1s |
| Apply formatting and safe fixes | `npm run format` | ~1s |
| Type check (TypeScript 7, `checkJs` strict; Node code and `ui/`) | `npm run typecheck` | ~2s |
| Lint Markdown | `npm run lint:md` | ~1s |
| Test (all, offline) | `npm test` | ~2s |
| Test (single file) | `node --test test/unit.test.mjs` | ~1s |
| Test (name filter) | `node --test --test-name-pattern="secrets" test/*.test.mjs` | ~2s |
| Tests with coverage thresholds | `npm run test:coverage` | ~2s |
| Full check (the CI gate) | `npm run check` | ~5s |
| Live check: 3 Anthropic calls, Jev mocked | `npm run test:live` | ~5s |
| Jev evaluation, live or mocked | `npm run eval` / `npm run eval:mock` | ~30s / ~1s |
| Run the router | `npm start` | n/a |
| Run the router with its live view | `npm start -- --ui 4100` | n/a |
| Live view of a router log | `npm run ui -- router.log` | n/a |
<!-- AGENTS-GENERATED:END commands -->

`npm ci` installs only dev tools: Biome, TypeScript, markdownlint-cli2 and `@types/node`. The router has no runtime
dependencies. `test:live` and `eval` spend real money (a fraction of a cent) and need keys; nothing else touches the
network.

## Response Style

- Answer first, elaborate only if needed. No sycophantic openers.
- For yes/no or status questions, lead with the answer.
- Skip preamble. Match response length to task complexity.

## Workflow

1. **Before coding**: read this file and the Golden Samples below. Real Jev and upstream keys aren't available in CI
   or most dev sandboxes; the tests run the router against mock upstreams and a scriptable mock Jev.
1. **After each change**: run the single test file that covers it, then `npm run lint` and `npm run typecheck`.
1. **Before committing**: `npm run check`.
1. **Before claiming done**: paste the `# pass` / `# fail` summary from `npm test` as evidence.

## Golden Samples

| Area | File | Why |
| --- | --- | --- |
| Routing rule | `src/router.mjs` (`decide`) | Deterministic rules run before Jev, and every outcome carries its own `reason` |
| Tier policy | `src/jev.mjs` (`applyPolicy`) | A pure function from Jev's answer to a tier, where guards can only raise the result |
| Config validation | `src/config.mjs` (`validateConfig`) | Fills defaults and collects every problem before throwing once |
| Integration test | `test/router.test.mjs` | Mock upstreams and mock Jev; `delta()` asserts the calls each test made |
| Unit test | `test/unit.test.mjs` | Pure functions; fake credentials assembled at runtime with `fake()` |

## Heuristics (quick decisions)

<!-- AGENTS-GENERATED:START heuristics -->
| When | Do |
| --- | --- |
| Adding a config key | Default and validation in `validateConfig` (`src/config.mjs`), the key in both `config/*.json` when users should see it, a row in `docs/configuration.md` and the README summary, a test in `test/unit.test.mjs` |
| Changing `jev.question` or `jev.options` | Change both packaged configs, run `npm run eval` live, and put the summary in the PR. Never name a model in the rubric; `buildQuestions` has a test for that |
| Changing what Jev sees | `buildState` in `src/jev.mjs`: scrub secrets before truncating, never add tool output, file contents or system prompts, re-run the eval |
| Adding a routing rule | `decide()` in `src/router.mjs` with a new `reason`, a row in the README's "How routing works" table, an integration test with `delta()` |
| Adding a secret pattern | `PATTERNS` in `src/secrets.mjs`, tested with a value built by `fake(...)` |
| Adding a harness wrapper tag | `WRAPPER_TAGS` in `src/messages.mjs`, with a `humanTurns` unit test |
| Adding an upstream target | `surfaces.<surface>.<name>` with `url`, `model`, `auth`, `keyEnv` or `clientAuth`, and `trusted`; an untrusted tier needs a `trusted` target; add its prices |
| Logging | JSON lines through the injected `log`; never prompt text or keys (a test scans every log line the suite writes) |
| Router-raised errors | `fail()` in the client's own error shape; 4xx responses carry `x-should-retry: false` |
| Writing a test | `test/<area>.test.mjs` with `node:test` and `node:assert/strict`; listen on port 0 through `listen()` in `test/helpers.mjs`; assert call deltas, never totals |
| Adding a CLI command | `src/cli.mjs`, `test/cli.test.mjs`, the CLI section of `README.md`, and `docs/activation.md` when it touches client setup |
| Editing Markdown | `npm run lint:md`: MD013 at 120 characters, tables and code blocks exempt |
| Editing `AGENTS.md` | `cp AGENTS.md CLAUDE.md`; the two files stay identical |
| Releasing | Bump `package.json` and `VERSION` in `src/router.mjs`, move `Unreleased` in `CHANGELOG.md` to the new version |
| Adding a dependency | Don't add runtime dependencies. A dev dependency needs a reason in the PR |
<!-- AGENTS-GENERATED:END heuristics -->

## Boundaries

### Always Do

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `ci:`, `chore:`).
- Keep lint, types and Markdown passing: `npm run check` is the gate, locally and in CI.
- Give every exported function a JSDoc comment; `tsc` checks the JSDoc types in strict mode.
- Assemble fake credentials in tests at runtime (`fake('AKIA', '…')`), so secret scanners and push protection don't
  flag the test files.
- Assert call deltas in integration tests (`delta()` in `test/router.test.mjs`), so a call left over from an earlier
  test can't make a test pass.
- Re-run the Jev evaluation (`npm run eval`) after any change to the Jev question, the options or the state, and
  record the result in the PR.
- Keep `README.md`, the docs, `CHANGELOG.md`, `package.json` and `VERSION` in sync.

### Ask First

- Changing the default tiers, target models, thresholds or Jev channels in `config/*.json`.
- Changing what leaves the machine: the Jev state, the headers or fields sent to untrusted targets.
- Changing the state file format or the log line fields (`report` and users' tooling read them).
- Loosening the Host, Origin, content-type or token checks, or the loopback default.
- Modifying `.github/workflows/`.

### Never Do

- Add runtime dependencies or a build step.
- Commit secrets, real API keys, `.env` files, router logs or eval results.
- Log prompt text or keys, or send a key to any host other than its own target or channel.
- Put model names in the Jev question or options.
- Let a pin, a tag or a Jev answer move a session that contained a secret to an untrusted target.
- Forward error bodies modified, or buffer a streamed response.

## Contracts this code depends on

| Contract | Where verified | Notes |
| --- | --- | --- |
| Claude Code gateway protocol: `/v1/messages?beta=true`, `anthropic-*` headers forwarded verbatim, optional `count_tokens`, unmodified error bodies | code.claude.com/docs/en/llm-gateway-protocol | `src/router.mjs` |
| Claude Code hint header `x-claude-code-request-class` (`main`, `subagent`, `workflow`, `compaction`, `auxiliary`) | Claude Code 2.1.273+, with `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` | `requestKind` |
| Claude Code session ID in `x-claude-code-session-id` and in `metadata.user_id` (JSON with `session_id`) | Claude Code 2.1.281 binary | `sessionKey` |
| Harness wrapper tags (`system-reminder`, `bash-stdout`, `command-name`, …) | Claude Code 2.1.281, Codex CLI 0.156.1 | `WRAPPER_TAGS` in `src/messages.mjs` |
| Codex: `wire_api = "responses"` only, `session-id` and `thread-id` headers, `x-openai-subagent`, `prompt_cache_key`, `store: false` | openai/codex source at `rust-v0.156.1` | `sessionKey`, `requestKind` |
| Codex model catalog (`model_catalog_json`) and `base_instructions` | openai/codex `rust-v0.156.1` | `examples/codex/jev-models.json` |
| System One API: `POST {base}/v1/systemone`, bearer key, `{model, state, questions}`, answers with `choice`, `probabilities`, `noul` | docs.typesafe.ai/api; OpenRouter `/api/v1/systemone` | `JevClient` in `src/jev.mjs` |
| Ollama Cloud serves `/v1/messages` and stateless `/v1/responses`, accepts only a bearer key, has no `count_tokens` | docs.ollama.com | `auth: "bearer"`, `countTokens: false` |
| Haiku 4.5 rejects adaptive `thinking`, `output_config.effort`, and `context_management` without thinking | live check, 2026-09-24 | `omit` on `surfaces.anthropic.side` |
| OpenAI model names `gpt-6-astra` and `gpt-6-sol` | Codex's bundled catalog, **not verified** against the OpenAI API | `config/*.json` |

## Module boundaries

<!-- AGENTS-GENERATED:START module-boundaries -->
| Module | May import |
| --- | --- |
| `config`, `messages`, `secrets`, `sessions`, `usage` | Node built-ins only, nothing from `src/` |
| `jev` | `messages`, `secrets` |
| `router` | `jev`, `messages`, `secrets`, `sessions`, `usage` |
| `cli` | anything in `src/`; only `bin/jev-router.mjs` imports it |
| `eval/run.mjs`, `test/*` | anything in `src/` |
<!-- AGENTS-GENERATED:END module-boundaries -->

## Scoped AGENTS.md (MUST read when working in these directories)

<!-- AGENTS-GENERATED:START scope-index -->
- none; this root file covers the whole repository
<!-- AGENTS-GENERATED:END scope-index -->

## When instructions conflict

Explicit user prompts override this file. Where this file and `README.md` or the docs disagree, fix whichever is
wrong, and keep `CLAUDE.md` identical to this file.
