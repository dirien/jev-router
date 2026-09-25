# Comparison with other Jev routers

## At a glance

| Project | Clients and upstreams | When Jev decides | Claude Code on a Haiku 4.5 tier | Pick it for |
| --- | --- | --- | --- | --- |
| jev-router 1.6.0 | Claude Code and Codex, each on its own protocol; Anthropic, OpenAI, Ollama Cloud | Once per human message; a session only moves up | Rejected fields dropped, `max_tokens` capped, system messages folded, 1M beta dropped (live) | Your own Claude Code and Codex sessions, with Claude, OpenAI or Ollama Cloud tiers |
| LiteLLM 1.102.1 | Messages, Responses, Chat Completions; 100+ providers, with translation | Every request by default, tool-loop steps included (mock) | `max_tokens` capped, thinking converted; system messages passed through (mock) | A team gateway: virtual keys, budgets, spend tracking, an admin UI |
| Jevonian 0.1.7 | Messages, Responses, Chat Completions, bridged; many providers | Every request; the model can change on any turn (mock) | Turns Jev sends to Haiku fail with a 400 (live) | Many clients and providers behind one local endpoint, with a dashboard |
| gargpratyush/jev-router 0.3.0 | Claude Code to Anthropic, Codex to OpenAI | Each new user turn, unless a system message follows it (mock) | Thinking and effort dropped; `max_tokens` and system messages passed through (mock) | Same-vendor tiering, also on Windows; last commit 2026-09-19 |
| Switchboard 0.1.0 | Claude Code to Anthropic, Codex to OpenAI or ChatGPT | Once per conversation (docs) | Thinking and effort dropped; `max_tokens` and system messages passed through (source) | Packaged same-vendor tiering that also sets the reasoning effort |

We checked each project on 2026-09-25. The labels say how a result was checked: *live* against Anthropic's API;
*mock* locally, against mock upstreams and a mock Jev; *source* by reading the code without running it; *docs* from
the project's documentation, not tested. jev-router cells without a label come from its code and offline tests.

## Versions compared

| Project | Version | Released | Changes since our first look on 2026-09-24 |
| --- | --- | --- | --- |
| jev-router | 1.6.0 | This release | 1.3.3 plus the env file, the launchd and systemd services, log rotation, `jev-router setup` to install them, and Fable 5.1 as an optional fourth tier |
| [LiteLLM](https://github.com/BerriAI/litellm) | 1.102.1 (PyPI) | 2026-09-23 | No newer stable release with the Jev classifier. Still open: a confidence gate for Jev route-downs ([#42387](https://github.com/BerriAI/litellm/pull/42387)) and five Jev issues |
| [Jevonian](https://github.com/xinyao27/jevonian) | 0.1.7 (npm) | 2026-09-23 | None; the last commit is from 2026-09-23 |
| [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router) | 0.3.0 (npm) | 2026-09-18 | None; the last commit is from 2026-09-19 |
| [Switchboard](https://github.com/ruban-24/switchboard) | 0.1.0 (npm, Homebrew) | 2026-09-21 | Documentation only. Two pull requests opened on 2026-09-25 add GPT-6 and Opus 5.5 routes and a settings menu |

How we produced the results:

- Versions and activity come from npm, PyPI and the GitHub API on 2026-09-25.
- LiteLLM 1.102.1 and gargpratyush/jev-router 0.3.0 ran on 2026-09-25 against a mock Anthropic upstream and a mock
  Jev. The requests had the shape Claude Code 2.1.281 sends: adaptive `thinking`, `output_config.effort`,
  `context_management`, `max_tokens: 128000`, system messages after the prompt, and the 1M-context beta.
- Jevonian 0.1.7 ran on 2026-09-24 against Anthropic's API, with a mock Jev.
- We read Switchboard's request handling in its source and didn't run it.
- The test suites passed: 65 tests for gargpratyush/jev-router and 266 for Switchboard (on Node 24) on 2026-09-25,
  and 577 unit tests plus 61 smoke checks for Jevonian on 2026-09-24.
- Claude Code's behavior behind a gateway comes from Anthropic's
  [gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol).

## Detailed comparison

### Clients and protocols

| Project | Clients | Upstreams |
| --- | --- | --- |
| jev-router | Claude Code on Anthropic Messages (`/v1/messages`, `count_tokens`); Codex on OpenAI Responses (`/v1/responses`) | Anthropic, OpenAI and Ollama Cloud, each in the client's own protocol. It doesn't translate between protocols, so it can't run Claude Code on a GPT model |
| LiteLLM | Anthropic Messages, OpenAI Responses and Chat Completions | 100+ providers, with translation between protocols, so Claude Code can run on a GPT model (docs) |
| Jevonian | The same three protocols, with bridges between them | Provider presets (DeepSeek, Anthropic, OpenAI, Moonshot, Z.ai, MiniMax, Qwen, xAI, Gemini, OpenRouter and others), custom endpoints, and subscription sign-ins (docs) |
| gargpratyush/jev-router | `jev-claude` and `jev-codex` start each CLI behind its own proxy | The CLI's own vendor: Anthropic, or OpenAI with an API key or a ChatGPT login |
| Switchboard | `switchboard claude` and `switchboard codex` start each CLI behind its own proxy | The CLI's own vendor: Anthropic, or OpenAI with an API key or a ChatGPT login |

Anthropic doesn't support routing Claude Code to non-Claude models through a gateway
([Claude Code docs](https://code.claude.com/docs/en/llm-gateway)). jev-router's default config sends Claude Code's
`fast` tier to Ollama Cloud; `config/anthropic-only.json` keeps Claude Code on Haiku 4.5, Sonnet 5 and Opus 5.5, and
`config/anthropic-fable.json` adds Fable 5.1.
LiteLLM and Jevonian can cross vendors too. gargpratyush/jev-router and Switchboard stay with each CLI's vendor.

### When Jev is asked

| Project | When it asks | What it asks |
| --- | --- | --- |
| jev-router | Once per new human message, shared by every request of that turn. Tool-loop steps, subagents, compaction, `count_tokens` and background calls never ask (one Jev call per human message in the live check) | One choice among four work categories that map to tiers, plus two guard questions that can only raise the tier. The channels pin `jev-1.13.0` |
| LiteLLM | With the default `classification_mode: every_request`, on every request: a tool-result continuation made a second Jev call in our run (mock). `user_turn` asks only on new human messages (source) | A fixed four-tier choice over the current ask, up to three earlier user turns and a size estimate, with `jev-latest` by default. Custom tier definitions for more than one router need an Enterprise license (docs) |
| Jevonian | On every `jevonian/auto` request, tool-loop steps included (mock) | One choice of route and one of thinking effort (mock) |
| gargpratyush/jev-router | On each new user turn; tool-loop steps reuse the answer. A turn followed by a system message, as SessionStart hooks add, isn't routed: no Jev call, default model (mock; issues [#28](https://github.com/gargpratyush/jev-router/issues/28) and [#48](https://github.com/gargpratyush/jev-router/issues/48)) | A choice among the account's models plus three scores (source) |
| Switchboard | On the first task of a conversation. A later user turn can ask again, but only to recommend a stronger model for a new conversation (docs) | Capability tier, whether there's enough context, task type, and an effort question for each eligible model, in one request (docs) |

### Mid-session model switches

| Project | Can a session change model mid-task? |
| --- | --- |
| jev-router | Only upward, and only at a human message (`policy.mode: "ratchet"`). A session is decided afresh, and can go down, after 10 idle minutes, after compaction or a fork shortens its history, or after `/clear`. `sticky` mode decides once per session |
| LiteLLM | By default on any request, inside a tool loop too. `classification_mode: user_turn` limits switches to new human messages, in either direction; `session_affinity: true` keeps the first turn's model for the session (source) |
| Jevonian | On any request, tool loops included, and no setting pins a `jevonian/auto` session (mock). Explicit aliases such as `jevonian/execute` skip Jev (mock) |
| gargpratyush/jev-router | At each new user turn. It refuses a downgrade below 0.3 confidence or above about 20,000 context tokens, to protect the prompt cache (source) |
| Switchboard | No. Model and effort stay fixed through tool calls, follow-ups and resume (docs) |

Each switch starts the new model's prompt cache from scratch, so the next request pays to write the whole context
again. [design.md](design.md#decide-at-human-turns-and-only-move-up-mid-session) has the measurements.

### Claude Code compatibility

Behind a gateway, Claude Code shapes each request for the model it thinks it's talking to. jev-router keeps Claude
Code's own model name (Opus 5.5, say), so Claude Code keeps that model's features, and the router adapts the requests
it sends to a smaller model. The other routers show Claude Code an alias (`claude-jev-router`, `jevonian/auto`,
`jev-router`, `switchboard`). For an alias, Claude Code sends every field current Claude models accept and assumes a
200K window unless the ID carries `[1m]` ([gateway guide](https://code.claude.com/docs/en/llm-gateway-protocol)).

The live checks on 2026-09-24 with Claude Code 2.1.281 hit six problems. The first five broke turns routed to Haiku
4.5:

1. Adaptive `thinking`, `output_config.effort`, and a `context_management` edit without thinking: 400.
1. `max_tokens: 128000`, sized for Opus 5.5: Haiku 4.5 accepts at most 64000, and the turn failed.
1. `role: "system"` messages inside the conversation, which Claude Code sends to Claude 5 models: "role 'system' is
   not supported on this model".
1. The 1M-context beta, which Claude Code adds once its model has a 1M window: on a subscription login, Haiku 4.5
   answered "The long context beta is not yet available for this subscription".
1. Tool additions inside those system messages: the API accepts them only in a system message, so folding a message
   that carried one failed.
1. MCP tool search: Claude Code turns it off for any base URL that isn't Anthropic's unless `ENABLE_TOOL_SEARCH=true`
   is set ([environment variables](https://code.claude.com/docs/en/env-vars)). A few MCP servers then put around 200K
   tokens of tool definitions into every request, more than the 160K compaction window, and Claude Code compacted on
   every message.

After a rejected `thinking` field or system message, Claude Code retries and turns that capability off for the rest of
the conversation. It doesn't retry rejected context management or tool schema fields, so those errors reach you
([gateway guide](https://code.claude.com/docs/en/llm-gateway-protocol)).

| Project | `anthropic-beta` | Thinking, effort, context management | `max_tokens` over the limit | System messages inside the conversation | MCP tool search |
| --- | --- | --- | --- | --- | --- |
| jev-router | Forwarded; the 1M beta is dropped for Haiku 4.5 (live) | Dropped for Haiku 4.5 by the target's `omit` list (live) | Lowered to the model's limit, 64000 for Haiku 4.5 (live) | Folded into the user message before them; tools they add join `tools` (live) | `launch claude`, `env claude` and the example env file set `ENABLE_TOOL_SEARCH=true` |
| LiteLLM | Forwarded unchanged, 1M beta included (mock) | Adaptive thinking becomes a 4,096-token budget, effort is dropped, `context_management` is forwarded (mock) | Lowered to 64000 when the router picks Haiku 4.5; not for a direct model name (mock) | Forwarded unchanged (mock) | Its `lite` CLI sets `ENABLE_TOOL_SEARCH=true` (source) |
| Jevonian | Not forwarded, so `context_management` gets a 400 (live). `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` stops Claude Code from sending it (docs) | Forwarded; Haiku 4.5 returns a 400 for adaptive thinking (live) | Not tested | Not adapted (source) | Not set by its launcher (source) |
| gargpratyush/jev-router | Forwarded unchanged, 1M beta included (mock) | Thinking, effort and thinking-related context edits dropped (mock) | Forwarded unchanged (mock) | Forwarded; the turn they follow isn't routed (mock) | Not set by its launcher (source) |
| Switchboard | Forwarded (source) | Thinking, effort and thinking-related context edits dropped (source) | Forwarded unchanged (source) | Forwarded; its tests expect Haiku 4.5's 400 and Claude Code's retry (source) | Not set by its launcher (source) |

We didn't test whether Claude Code sends `max_tokens` above 64000, system messages or the 1M beta when its model is an
alias. The cells marked "forwarded" show what would reach Haiku 4.5 if it does.

Two more differences:

- `count_tokens`: jev-router forwards it for the session's model, or answers a local 404 for a target without it, and
  Claude Code then estimates. LiteLLM 1.102.1 skipped its routing hook for `count_tokens` in a 2026-09-24 test with a
  custom Jev hook; with the built-in classifier: not tested. Jevonian answers with a local estimate that ignores the
  model (live: 2.3% above Anthropic's count). gargpratyush/jev-router and Switchboard: not reviewed.
- Upstream response headers such as `retry-after` and the rate-limit headers, which Claude Code uses for backoff:
  jev-router passes them through (offline tests), and so do gargpratyush/jev-router and Switchboard (source). Jevonian
  doesn't relay them (source). LiteLLM: not reviewed.

### Haiku 4.5 as a tier

| Project | Haiku 4.5 as a routed tier |
| --- | --- |
| jev-router | The `fast` tier in `config/anthropic-only.json`, which routes Claude Code across Haiku 4.5, Sonnet 5 and Opus 5.5. In the live check, turns routed to Haiku 4.5 with Claude Code's full field set answered 200. In the default config, Haiku 4.5 serves only Claude Code's background calls |
| LiteLLM | Any model can be a tier. What reaches Haiku 4.5 is in the table above (mock); a live Haiku turn through the Jev router: not tested |
| Jevonian | Only for background calls pinned by the real model ID; a route Jev picks that lands on Haiku 4.5 gets a 400 (live) |
| gargpratyush/jev-router | The default fast tier; a live Haiku turn: not tested |
| Switchboard | The default fast tier, sent without an effort parameter; a live Haiku turn: not tested |

Fable 5.1 can serve a tier too. jev-router ships it as an option: `config/anthropic-fable.json`, which setup writes
for `--models fable`, adds a fourth tier, `max`, on `claude-fable-5-1` for Jev's `deep` option, `/model fable` and
`#max`. The other configs pin `frontier` when you switch to Fable 5.1 with `/model`. jev-router knows Fable 5.1's
output limit and that it takes system messages. Switchboard ships Fable 5.1 as its highest tier, and
gargpratyush/jev-router offers it behind `JEV_ALLOW_FABLE=1`.

### Secrets

| Project | Secrets in prompts | What Jev receives | Provider keys |
| --- | --- | --- | --- |
| jev-router | A deterministic scanner checks every human message: private keys, common API token formats, JWTs, credentials in URLs, `password=` assignments. A hit keeps the session on its `trusted` target, and untrusted targets get those secrets redacted anywhere in the body, tool output included | The latest human message with harness text removed, code blocks summarized, secrets scrubbed, cut to 4,000 characters; up to two earlier ones; named buckets for session depth and tool use. It never gets tool output, file contents or the system prompt | Each key comes from the variable its target names and goes only to that host. Redirects are refused. Your Claude login goes only to Anthropic. Keys live in `~/.config/jev-router/env`, which setup writes with mode 0600 and every command loads, with a warning when others can read it |
| LiteLLM | No scanning on the Jev routing path; its guardrails: not reviewed | The current ask, up to three earlier user turns and a size estimate, with Claude Code's harness text stripped (docs) | In the config, the environment or its database; clients use a master key or virtual keys |
| Jevonian | Shell commands are redacted before the Jev call; no scanner | Recent messages, tool calls and trimmed tool results, about 10 KB per call (mock) | Added with its CLI or dashboard |
| gargpratyush/jev-router | No scanner | The prompt, the current model, the context size and the available models (source) | The Jev key in `~/.jev-router.env` or the environment; the CLI's own login is forwarded unchanged |
| Switchboard | No scanner. Its docs say the task text goes to Jev with any secrets in it | The extracted task text, up to 16,000 characters (docs) | The Jev key, entered at a hidden prompt, in a file only you can read; the CLI's own login is forwarded |

### When Jev fails

| Project | What happens |
| --- | --- |
| jev-router | It tries TypeSafe, then OpenRouter: 1.2 s per attempt, one retry, 2.5 s per decision. A channel that times out is skipped for 30 s, one that answers 401, 402 or 403 for 5 minutes, and a firewall 403 gets one retry with a hardened state. A new session gets `balanced` provisionally and Jev is asked again on its next messages, three attempts in all; an existing session keeps its tier. The request itself never fails, and the log, `/healthz` and `report` show every fallback |
| LiteLLM | One attempt with a 3 s timeout, then a 30 s circuit breaker per process. `classifier_fallback` decides: the local keyword scorer by default, which can pick a cheap tier, or `default_model` (source). Jev's confidence is logged but not used (source; [#42387](https://github.com/BerriAI/litellm/pull/42387) is open) |
| Jevonian | Retries and fails over between Jev channels, then routes by a heuristic: the `plan` route for a first prompt, `execute` after tool results. A Jev that hangs cost about 25 s per request with the default 8 s timeout (mock). Without a Jev channel, `jevonian/auto` returns an error |
| gargpratyush/jev-router | 1.5 s per attempt, one retry, 3 s per decision. On any failure the session keeps its current model, and a new session starts on Opus (source) |
| Switchboard | A 3 s budget and no retries. A new conversation gets the configured fallback, Opus or GPT-5.6 Sol at high effort by default, and an existing one keeps its saved model and effort (docs) |

gargpratyush/jev-router and Switchboard call Jev through TypeSafe's JavaScript SDK 0.6.0. In our tests of that SDK
version on its own, a Jev response that stalled after its headers left an unhandled promise rejection, which ends a
Node process by default ([design.md](design.md#why-not-the-typesafe-sdk)). We didn't try it inside either router.

### Observability

| Project | Decisions | Cost | Live view |
| --- | --- | --- | --- |
| jev-router | A `route` log line per request (tier, reason, model, Jev channel, version, request ID, probabilities, guards, latency) and a `done` line (status, tokens, cost, and the upstream's error message when a request fails). `x-jev-*` response headers. `/healthz` shows each Jev channel's errors and circuit state | `cost_usd` and `baseline_usd` on every `done` line. `jev-router report` sums spend per model, savings against a baseline model, and Jev's fallback rate, latency and cost | `serve --ui 4100` serves an animated flow from the client through Jev's categories and the tiers to the models. Click a request to see Jev's answer, the guards and the reason for its tier. It also shows a timeline, each session's tier per human message, and totals |
| LiteLLM | Response headers with the tier, the cause, the served model and the classifier cost (mock). The Anthropic-format response body names the router alias, not the served model (mock) | Spend logs per key, team and model, and an admin UI, both with a database (docs). Its `lite` CLI adds a Claude Code status line with the routed model and the session's savings (docs) | Not reviewed |
| Jevonian | `x-jevonian-*` response headers and a JSONL ledger with each decision's reason (mock) | Estimated cost per request in the ledger (docs) | A web dashboard |
| gargpratyush/jev-router | A status line with the model and Jev's probability; `/jev-explain` shows the last decision's factors | None in the source | None |
| Switchboard | A Claude Code status line or a Codex notice with the model and effort; `switchboard explain` shows a saved decision with its confidence | Cache counters only; no usage dashboard or savings estimate in 0.1.0 (docs) | None |

### Security surface

The table lists what each router exposes on the machine it runs on, from its source or docs. It isn't an audit.

| Project | Surface |
| --- | --- |
| jev-router | The proxied `/v1/*` routes and `GET /healthz`, and nothing else. It listens on loopback and refuses a `Host` other than loopback (DNS rebinding), any request with an `Origin` header, and bodies that aren't JSON. A token is optional, and required before it listens on another address. The live view has its own port, loopback by default, serves only its page and event stream, checks `Host` and `Origin`, and never shows prompts or keys |
| LiteLLM | A gateway server with a management API and an admin UI; clients authenticate with a master key or virtual keys (docs) |
| Jevonian | Not compared here |
| gargpratyush/jev-router | A proxy per launch on a random loopback port; no token, `Host` or `Origin` checks in the source |
| Switchboard | A proxy per launch on a random loopback port; every request needs a per-launch token; bodies are capped at 16 MiB (source) |

### Operations

| Project | Config changes | State across restarts | Running it |
| --- | --- | --- | --- |
| jev-router | `SIGHUP` re-reads and validates the config, and keeps the old one if the new one is invalid. A bad config at startup lists every problem | Session tiers persist in a state file (hashed keys, no prompt text, seven-day expiry), so a restart doesn't move live sessions | A long-running local service on macOS or Linux: `jev-router setup` installs a launchd agent or a systemd user unit with the keys from the env file, or run `serve --ui 4100` in a terminal. `launch claude` starts a router for one session if none is running. `SIGTERM` lets streams finish for up to 30 s, and the log rotates at `logMaxBytes` |
| LiteLLM | Models and routers change through its API and UI when a database is attached (docs); reloading a YAML config: not reviewed | Session-affinity pins live in its cache with an idle TTL (docs) | A gateway you deploy and operate, with Docker images (docs) |
| Jevonian | A JSON config file and the dashboard; in our run, CLI edits took effect only after a restart | Routing state in memory; the ledger on disk | A LaunchAgent on macOS, in the foreground elsewhere (docs) |
| gargpratyush/jev-router | Environment variables and `src/config.mjs`, read at launch | In memory for each launch; the last 20 decisions per session in temporary files for seven days | Starts with each `jev-claude` or `jev-codex` session; nothing to keep running |
| Switchboard | A personal `policy.json`, read at launch; `switchboard config check` validates it | Each conversation's model and effort are saved on disk, so a resumed session keeps them | Starts with each `switchboard claude` or `switchboard codex` session |

### Install

| Project | Install | Runtime |
| --- | --- | --- |
| jev-router | `npx github:dirien/jev-router setup`, or `npm install -g github:dirien/jev-router#semver:^1` and `jev-router setup`, on any macOS or Linux machine; setup asks for the keys and saves them in `~/.config/jev-router/env` (mode 0600). The Docker Sandboxes kit is optional | Node.js 22 or newer, no runtime dependencies |
| LiteLLM | `uv tool install 'litellm[proxy]'`, `pip`, or its Docker image | Python; 108 packages and 564 MB in our install |
| Jevonian | `npm install -g jevonian` | Node.js 22 or newer, five runtime dependencies; AGPL-3.0 |
| gargpratyush/jev-router | `npm install -g jev-router`, with the Jev key in `~/.jev-router.env`. That npm package is this project, not ours | Node.js 20.12 or newer, one runtime dependency |
| Switchboard | `npm install -g @ruban24/switchboard`, `brew install ruban-24/tap/switchboard` or `npx`; `switchboard init` asks for the Jev key | Node.js 22.18 or newer, three runtime dependencies; macOS and Linux |

The everyday setup is a router on the same machine as the agent. `jev-router setup` runs it as a service and points
Claude Code's `~/.claude/settings.json` at it; by hand, run `jev-router serve --ui 4100` and point Claude Code at it
with `eval "$(jev-router env claude)"`. The live view is at `http://127.0.0.1:4100`.

### Maturity

| Project | Tests and CI | Age and activity |
| --- | --- | --- |
| jev-router | An offline suite against mock upstreams and a mock Jev (97 tests in 1.3.3) with coverage thresholds, Biome, strict type checks and markdownlint. CI on Node.js 22 and 24, plus actionlint. A live check against Anthropic and a Jev evaluation harness with 58 labeled prompts | First release on 2026-09-24, one maintainer |
| LiteLLM | A large suite and near-daily releases | A mature gateway with 59,590 GitHub stars on 2026-09-25. The Jev classifier merged on 2026-09-18, and five of its issues are open |
| Jevonian | 577 unit tests and 61 smoke checks passed in our run; no CI in the repository | First npm release on 2026-09-21, 11 releases in three days, one maintainer, no commits since 2026-09-23 |
| gargpratyush/jev-router | 65 tests passed in our run; CI runs on pull requests | Last commit on 2026-09-19; 27 open issues and pull requests, among them #28 and #48 (routing silently off) and [#35](https://github.com/gargpratyush/jev-router/issues/35) (the 1M window shown as 200K) |
| Switchboard | 266 tests passed in our run; CI on Ubuntu and macOS with Node.js 22.18 and 24. Interactive checks with Claude Code 2.1.278 and Codex 0.155.1 (docs) | First release on 2026-09-21, one maintainer. Its changelog says the OpenRouter path hasn't been tested live |

### Other Jev routers

These came up when we surveyed Jev routers on 2026-09-24. We didn't test them.

- [jcm-router](https://github.com/adarshmishra07/jcm-router) (Bun, Claude Code to Anthropic) routes every subagent and
  switches the main chat only when a cost guard says the switch pays for rebuilding the cache. Its README reports a
  $19.53 loss over 309 requests from an earlier version that switched the main chat freely. Last commit on 2026-09-17.
- The [jev-model-router mod](https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/mods/productivity/jev-model-router)
  in claude-code-templates runs inside Claude Code as a function-hooks mod (early access, Claude Code 2.1.259 or newer),
  with no gateway. By default it routes subagent models and the main loop's effort; main-loop model routing is off.
- [auto-model-router](https://github.com/fstandhartinger/auto-model-router) is an experimental router that minimizes
  expected cost, with a Claude Code gateway mode. It defaults to a local Laya classifier, with hosted Jev as an option.
- [0xNatoshi/jev-codex-router](https://github.com/0xNatoshi/jev-codex-router), a Codex-only router, was archived by
  2026-09-25.

## Where jev-router does better, and why it matters

### Claude Code keeps working on a cheaper Claude model

Each of the first five problems in [Claude Code compatibility](#claude-code-compatibility) broke Claude Code turns in
the live checks, and jev-router handles all five. A turn that fails once and succeeds on retry costs latency and turns
off a capability for the rest of the conversation. A `max_tokens` or context management rejection fails the turn
outright. LiteLLM, gargpratyush/jev-router and Switchboard adapt thinking and effort, and
LiteLLM also lowers `max_tokens`, but none of them folds system messages (mock or source). Jevonian forwards Claude
Code's adaptive thinking to Haiku 4.5, which answers with a 400 (live).

### MCP tool search stays on

Without `ENABLE_TOOL_SEARCH=true`, Claude Code behind any gateway sends every MCP tool's definition with every request.
In the live tests that meant compaction on every message. jev-router's `launch`, `env` and example env file set the
variable, and so does LiteLLM's `lite` CLI. With Switchboard, gargpratyush/jev-router or Jevonian you have to set it
yourself (whether their proxies then carry tool search: not tested).

### Models change only at human messages

jev-router asks Jev once per human message and moves a session only up, so a tool loop never switches models and loses
its prompt cache. With its defaults, LiteLLM asks on every request; Jevonian always does, and both can switch inside a
tool loop. Switchboard avoids switches by deciding once per conversation, so a conversation that gets harder stays on
its first model and Switchboard only recommends starting a new one.

### Every decision is visible

A router that skips turns without saying so leaves sessions on whatever model they had. gargpratyush/jev-router skips
a turn that a system message follows, and in our run that turn went to its default Opus without a Jev call.
jev-router counts human messages instead of looking only at the last message, and every request leaves a `route` line
with its reason. In the live view you can click any request to see Jev's answer, each tier's threshold, the guards, and
why the router took or passed over Jev's tier.

### Secrets stay with trusted upstreams

jev-router scans every human message for secrets, and none of the other four does so by default (LiteLLM's optional
guardrails: not reviewed). That matters when a tier runs outside Anthropic: a session whose messages contained a key
stays on its trusted target, and an untrusted target gets the secrets redacted.

### A router you can leave running

The state file keeps each session on its tier across restarts, `SIGHUP` reloads the config, and the launchd and systemd
templates keep the router running with keys from the env file. One router then serves every Claude Code session
configured through `settings.json`. The per-launch wrappers, gargpratyush/jev-router and Switchboard, don't need a
service, but they route only the sessions started through them.

## When to pick something else

- LiteLLM, for a gateway shared by a team: virtual keys, budgets, spend tracking and an admin UI, 100+ providers,
  and translation for pairs such as Claude Code on a GPT model. With Jev, set `classification_mode: user_turn` or
  `session_affinity: true` so tool loops don't switch models, and `classifier_fallback: default_model` so a Jev outage
  falls back to a capable model. Connect Claude Code with its `lite` CLI, which sets `ENABLE_TOOL_SEARCH`. System
  messages still reach a Haiku tier unchanged (mock).
- Switchboard, for packaged tiering within one vendor: npm or Homebrew, guided setup, reasoning effort picked per
  model, a Claude Code status line, and CI on macOS and Linux. It suits you if one decision per conversation is enough
  and you don't want Ollama Cloud or cross-vendor tiers. Set `ENABLE_TOOL_SEARCH=true` yourself if you use MCP servers
  (not tested with Switchboard).
- gargpratyush/jev-router, for per-turn tiering within one vendor on Windows, with a "Jev Router" entry in Claude
  Code's `/model` picker. Its README says it was developed and tested on Windows against Claude Code 2.1.101. Read its
  open issues first: there have been no commits since 2026-09-19.
- Jevonian, for more clients and providers behind one endpoint: Chat Completions clients, many provider presets,
  subscription quotas and a dashboard. With Claude Code, set `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` and keep Haiku
  4.5 out of the routes Jev can pick.
- No gateway at all: the claude-code-templates mod routes subagents and effort from inside Claude Code, so gateway
  issues such as tool search don't arise. It's early access, and we didn't test it.

## What we didn't verify

- jev-router: tuned thresholds on real Jev answers, Ollama Cloud and OpenAI as live upstreams, and full Codex sessions.
- A live Haiku 4.5 turn through LiteLLM, gargpratyush/jev-router or Switchboard; their cells come from mock runs or the
  source.
- What Claude Code sends for an alias model: `max_tokens` above 64000, system messages, the 1M beta.
- Codex through any router other than jev-router's offline tests.
- LiteLLM's YAML reload, its guardrails, and a live view of its decisions.
- The SDK stall inside gargpratyush/jev-router and Switchboard.
- Windows, for every project.

## Sources

- Claude Code: [gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol),
  [LLM gateways](https://code.claude.com/docs/en/llm-gateway),
  [environment variables](https://code.claude.com/docs/en/env-vars)
- LiteLLM: [auto routing reference](https://docs.litellm.ai/docs/proxy/auto_routing),
  [complexity router at 1.102.1](https://github.com/BerriAI/litellm/blob/v1.102.1/litellm/router_strategy/complexity_router/README.md),
  [client CLI at 1.102.1](https://github.com/BerriAI/litellm/blob/v1.102.1/litellm/proxy/client/cli/README.md),
  [open Jev issues](https://github.com/BerriAI/litellm/issues?q=is%3Aissue+is%3Aopen+jev)
- [Jevonian](https://github.com/xinyao27/jevonian),
  [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router),
  [Switchboard](https://github.com/ruban-24/switchboard) and its
  [routing](https://github.com/ruban-24/switchboard/blob/main/docs/routing.md) and
  [native CLI](https://github.com/ruban-24/switchboard/blob/main/docs/native-cli.md) docs
- jev-router: [design.md](design.md), [configuration.md](configuration.md) and the [changelog](../CHANGELOG.md)
