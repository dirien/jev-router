# jev-router

A local model router for Claude Code and the Codex CLI that picks a model tier for each human turn with Jev.

![Node.js 22 or newer](https://img.shields.io/badge/node-%E2%89%A522-5fa04e)
![No runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-blue)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

jev-router is a pass-through proxy that runs on your machine. Claude Code talks to it in Anthropic Messages and
Codex in OpenAI Responses. When a person writes a new message, the router asks [Jev](https://docs.typesafe.ai),
TypeSafe AI's System One decision model, which tier the work needs, and sends the session to a fast, balanced or
frontier model.

Many turns in a coding session don't need the most expensive model. Switching models in the middle of a task costs
more than it saves, though: the prompt cache is per model, and a stronger model that inherits a weaker model's
half-done transcript [recovers only part of the quality gap](https://arxiv.org/abs/2608.24358). So the router
decides only when a person writes, and within a session it only moves up.

Requests go upstream unchanged except for `model`, the credential, and fields a target can't accept. Responses,
SSE included, stream back byte for byte. There are no runtime dependencies: Node.js 22 or newer is all it needs.

> **Boundary:** Anthropic doesn't support routing Claude Code to non-Claude models through a gateway
> ([Claude Code docs](https://code.claude.com/docs/en/llm-gateway)). The default config sends Claude Code's fast
> tier to Ollama Cloud; [`config/anthropic-only.json`](config/anthropic-only.json) keeps Claude Code on Claude models.

## Tiers

| Client | `fast` | `balanced` | `frontier` | `trusted` (sessions that contained a secret) |
| --- | --- | --- | --- | --- |
| Claude Code | Ollama Cloud `glm-5.3-flash` | Anthropic `claude-sonnet-5` | Anthropic `claude-opus-5-5` | Anthropic `claude-sonnet-5` |
| Codex CLI | Ollama Cloud `glm-5.3-flash` | Ollama Cloud `kimi-k2.7-code` | OpenAI `gpt-6-astra` | OpenAI `gpt-6-sol` |

Claude Code's own background calls (session titles, topic checks, quota probes) go to `claude-haiku-4-5`.
[`config/anthropic-only.json`](config/anthropic-only.json) routes Claude Code's `fast` tier to Haiku 4.5 instead, so
Claude Code uses Haiku 4.5, Sonnet 5 and Opus 5.5; Codex routes the same way in both configs. The OpenAI model names
come from Codex's bundled model catalog, so check them against your account.

## Requirements

| | |
| --- | --- |
| Node.js | 22 or newer |
| Jev | A [TypeSafe](https://console.typesafe.ai) API key, an [OpenRouter](https://openrouter.ai) key with credits, or both for failover |
| Ollama Cloud | An API key for the `fast` tier, and for Codex's `balanced` tier |
| OpenAI | An API key for Codex's `frontier` and `trusted` tiers (optional if you only use Claude Code) |
| Anthropic | Your Claude login, or an `ANTHROPIC_API_KEY` for the router |
| Claude Code | 2.1.273 or newer, for the gateway hint headers (request shapes taken from 2.1.281) |
| Codex CLI | 0.134.0 or newer, for profile files (request shapes taken from 0.156.1) |

## Install

jev-router isn't published to npm. Install it from GitHub:

```bash
# While the repository is private (needs SSH access to it)
npm install -g git+ssh://git@github.com/dirien/jev-router.git

# Or from a clone
git clone git@github.com:dirien/jev-router.git
cd jev-router && npm install && npm link
```

Once the repository is public, `npm install -g github:dirien/jev-router` works too. To update, run the install
command again.

Don't run `npm install -g jev-router`: that name on npm belongs to an unrelated project
([gargpratyush/jev-router](https://github.com/gargpratyush/jev-router)). Both packages are named `jev-router`, so a
global install of one replaces the other.

## Quick start

```bash
export TYPESAFE_API_KEY=...   # Jev; or OPENROUTER_API_KEY, or both
export OLLAMA_API_KEY=...     # the fast tier
export OPENAI_API_KEY=...     # optional: Codex's frontier and trusted tiers
jev-router doctor             # checks the setup; --live adds one real Jev call (about $0.00003)
jev-router launch claude      # starts the router if needed, then Claude Code through it
```

Leave `ANTHROPIC_API_KEY` unset to keep using your Claude login: the router passes Claude Code's own credential to
Anthropic and to no other host. If you set it, the router uses that key for every Anthropic request instead, and the
API key pays.

In Claude Code, `/status` shows the router as the API base URL. Every request leaves a `route` line in the router
log (`~/.local/state/jev-router/router.log` when `launch` started the router) with the tier, the model and the
reason.

## Use it with Claude Code

There are three ways to point Claude Code at the router. [docs/activation.md](docs/activation.md) has the details.

1. **One shot.** `jev-router launch claude [-- claude args]` reuses a router that already answers on the port, or
   starts one inside its own process that logs to `~/.local/state/jev-router/router.log`. It runs `claude` with
   `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=160000` and
   `ENABLE_TOOL_SEARCH=true`, plus the
   `x-jev-router-token` header through `ANTHROPIC_CUSTOM_HEADERS` when a token is set. It never sets an API key,
   and it exits with Claude Code's exit code.
1. **This shell.** Run the router in another terminal (`jev-router serve`) or as a service, then
   `eval "$(jev-router env claude)"` and start `claude` as usual.
1. **Always.** Put the same variables in the `env` block of `~/.claude/settings.json` and run the router as a
   service (launchd on macOS, a `systemd --user` unit on Linux). Every Claude Code session then goes through the
   router, and fails to connect while it's down.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4000",
    "CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "160000",
    "ENABLE_TOOL_SEARCH": "true"
  }
}
```

`CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` labels each request as main loop, subagent, compaction, workflow or background
work, so only a person's messages decide the tier. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is there because Claude Code
can't learn the routed model's context window through a gateway: 160,000 tokens compacts before the smallest window
among the tiers. `ENABLE_TOOL_SEARCH=true` matters as much: behind any gateway Claude Code turns MCP tool search off
and sends every MCP tool's definition with every request, which with a few MCP servers exceeds that window by itself,
so Claude Code compacts on every message.

## Use it with Codex

```bash
jev-router launch codex [-- codex args]
```

`launch codex` writes a `jev` profile to `~/.codex/jev.config.toml` and runs `codex --profile jev`. A profile it
wrote is refreshed when the router's port or token changes; a profile you edited is kept (`--force` replaces it).
The profile talks to one virtual model, `jev-auto`, from
[`examples/codex/jev-models.json`](examples/codex/jev-models.json). Codex shapes every request from the model's
catalog entry (tool types, shell type, parallel tool calls), so the entry uses settings every routed model can handle.
It also carries Codex's own system prompt: an empty prompt there would silently drop Codex's instructions.

To set the profile up by hand, see [Codex profile by hand](docs/activation.md#codex-profile-by-hand).

## Watch routing live

The live view shows every decision as it happens, in a browser next to the terminal where Claude Code runs:

![The live view with a request selected: Jev rated it mechanical at 86%, and its route through the router, the
category and the fast tier to Haiku 4.5 streams across the flow while the rest of the graph dims](docs/live-view.png)

- **Latest decision.** Jev's category for the message you just sent, its probabilities against each tier's
  threshold, the guards, and the tier and model the router picked, with the reason in plain words.
- **Flow.** An animated graph from Claude Code or Codex through Jev's categories and the tiers to the models. Every
  request travels it as a dot; tool-loop steps, subagents and background calls skip Jev.
- **Timeline and sessions.** Each request with its status, tokens and cost, grouped under the message that started
  it, and each session's tier per human message, so the ratchet shows.
- **Totals.** Spend against the baseline model, Jev's latency and its fallbacks.
- **Any request, on a click.** Click a request in the timeline, or focus it and press Enter, and the decision panel
  and the flow switch to it: its route streams across the graph in its tier's color. A tool step, subagent or
  compaction shows the prompt whose decision it runs on; a background call shows that it always takes `side`.
  Escape, or **Back to live**, follows the traffic again; while following, the flow streams the newest request's route.

```bash
jev-router serve --ui 4100    # the router, plus its live view on http://127.0.0.1:4100
```

`--ui` (or `JEV_ROUTER_UI`) takes a port or `host:port`. The router hands the view every log entry in-process, so it
needs no log file. The view listens on loopback unless you give it an address. In a Docker Sandbox, let it listen on
the sandbox's network interface and forward the port from the host:

```bash
jev-router serve --ui 0.0.0.0:4100 2>&1 | tee -a router.log   # in the sandbox
sbx ports jev-router --publish 4100:4100                       # on the host, then open http://127.0.0.1:4100
```

For a router in another process, `jev-router ui [<log.jsonl>] [--port <n>]` serves the same view by following its
log: the one given, else `logFile` from the config, else the log that `launch` writes.

## How routing works

The router tracks each conversation as a **session**. It takes the session ID from Claude Code's
`X-Claude-Code-Session-Id` header or `metadata.user_id`, from Codex's `session-id` or `thread-id` header, from
`prompt_cache_key`, or else from a hash of the system prompt and the first messages. The log names the source as
`key_source`.

| Request | Tier | Asks Jev? |
| --- | --- | --- |
| `count_tokens` | The session's tier. A target with `countTokens: false` (Ollama Cloud) answers with a local 404, and Claude Code estimates instead | no |
| Background call: request class `auxiliary`, Codex memory consolidation, a `max_tokens <= 1` probe, or a `haiku` model when no request class is sent | `side`: `claude-haiku-4-5` for Claude Code, the `fast` target for Codex | no |
| Subagent, compaction, workflow | The session's tier | no |
| `x-jev-tier` header or `JEV_ROUTER_TIER` | That tier | no |
| `/model` switch to another model family in Claude Code | The family's tier from `modelPins` | no |
| `#fast`, `#balanced` or `#frontier` as the first or last word you type | That tier | no |
| Tool-loop step (no new human message) | The session's tier | no |
| New human message | Jev's answer through the policy: freely for a new, idle or provisional session, and only upward otherwise | yes, once per message |

Then, for every request, the router:

1. **Picks the target.** A session whose human messages contained a secret uses the `trusted` target from then on.
1. **Strips foreign reasoning.** When a session moves to another upstream host (Ollama Cloud to Anthropic, say),
   signed thinking from before the move is dropped, because another provider's signatures are always rejected.
   Between Anthropic models nothing is stripped, and subagent and compacted conversations are never touched.
1. **Redacts.** For an untrusted target it redacts secrets anywhere in the body, tool output included.
1. **Drops unsupported fields.** It removes the fields the target lists in `omit`, for example the adaptive
   `thinking`, `output_config.effort` and `context_management` that Haiku 4.5 rejects.
1. **Caps the output.** It lowers `max_tokens` to what the target's model accepts. Claude Code asks for 128,000
   output tokens because it believes it talks to Opus 5.5, and Haiku 4.5 refuses anything above 64,000. The limits
   of the Claude models in the shipped configs are built in, and a target's `maxOutputTokens` overrides them.
1. **Folds system messages.** Claude Code puts `role: "system"` messages inside the conversation for the Claude 5
   family. Haiku 4.5 rejects them, so for any other model the router folds each into the user message it follows,
   as `<system-reminder>` text after that message's tool results. A target's `foldSystemMessages` overrides it.
1. **Trims identifiers.** An untrusted target gets a minimal set of headers and no `metadata`.
1. **Forwards.** It streams the response back with back-pressure, and cancels the upstream request when the client
   goes away.

Every decision is in the log and in the response headers `x-jev-tier`, `x-jev-model`, `x-jev-reason` and
`x-jev-session` (plus `x-jev-redacted` when something was redacted).

**Choosing the tier yourself:**

- Put `#frontier` as the first or last word of a message. A tag inside a code block or mid-sentence doesn't count.
- Send `x-jev-tier: frontier`: through `ANTHROPIC_CUSTOM_HEADERS` for Claude Code, or `http_headers` in the Codex
  profile. Set `JEV_ROUTER_TIER` on the router to pin every session.
- Use `/model opus` in Claude Code. With `pinOnModelChange` on (the default), a switch to another model family pins
  that family's tier.
- Run `/clear` in Claude Code for a new session, which Jev decides from scratch.

None of these can move a session that contained a secret to an untrusted upstream.

[docs/design.md](docs/design.md) explains why the router works this way, with sources.

## Security and privacy

- **Loopback by default.** The router listens on `127.0.0.1:4000`. It refuses a `Host` header other than
  `127.0.0.1`, `localhost` or `[::1]` on its port (DNS rebinding), any request with an `Origin` header (browser tabs),
  and bodies that aren't JSON. It won't listen on a non-loopback address unless `JEV_ROUTER_TOKEN` is set; clients
  then send the token as `x-jev-router-token`.
- **Keys stay with their hosts.** Each key comes from the environment variable its target or Jev channel names, and
  goes only to that host. Upstream redirects are refused, so a key can't follow one. Your Claude login is forwarded
  only to targets marked `clientAuth` (Anthropic).
- **What Jev sees.** The latest human message, with harness text removed (system reminders, shell-mode output, hook
  output, command wrappers), code blocks replaced by a one-line summary, secrets scrubbed, and cut to 4,000
  characters keeping its start and end. Plus up to two earlier human messages, the last assistant message for short
  approvals like "yes, go ahead", and named buckets for session depth and recent tool use. Jev never sees tool
  output, file contents or the system prompt, and the questions it answers never name a model.
- **Secrets.** A deterministic scanner checks every human message for private keys, API tokens (Anthropic, OpenAI,
  OpenRouter, AWS, GitHub, GitLab, Slack, Stripe, Google, Pulumi), JWTs, credentials in URLs and `password=`-style
  assignments. A hit keeps the session on the `trusted` target. Untrusted targets get bodies with secrets redacted,
  a minimal set of headers and no `metadata`, so Claude Code's session and account identifiers stay with Anthropic.
  A pattern list can't catch every secret, so don't paste credentials into prompts.
- **What's stored.** The state file (`~/.local/state/jev-router/sessions.jsonl`, mode 0600) holds hashed session
  keys, tiers, trust flags, the last upstream host, and a hash of the message where the provider changed. It holds
  no prompt text. The log holds decisions, token usage and cost, never prompt text or keys.
- **The live view.** It has its own port and only shows log entries. It listens on `127.0.0.1` unless `--ui` names
  another address, and says so when it does: anyone who can reach that address sees models, tiers and costs, never
  prompts or keys. It answers only a `Host` that names loopback or the address it listens on (a wildcard address
  adds nothing, so DNS rebinding can't reach it), refuses a foreign `Origin`, serves nothing but its page and the
  event stream, and sends a Content Security Policy that allows only its own origin. The router's own port still
  refuses every browser request.
- **Where prompts go.** A session's requests go to the upstream its tier maps to, and Jev's small state goes to the
  first Jev channel that answers (TypeSafe, then OpenRouter). Check each provider's retention terms before you use
  the router on sensitive code. TypeSafe says Jev isn't trained on customer requests
  ([Models](https://docs.typesafe.ai/models)).

[SECURITY.md](SECURITY.md) explains how to report a vulnerability.

## Operations

- **Logs.** JSON lines on stdout under `serve` (under `launch`, in `~/.local/state/jev-router/router.log`, so the
  agent's terminal stays clean), also appended to `logFile` when it's set. Each request writes a `route` line
  (session hash, request kind, tier, reason, model, upstream, and the Jev channel, model version, request ID,
  probabilities, guard values and latency) and a `done` line (status, bytes, the SHA-256 of the streamed bytes, token
  usage, `cost_usd`, `baseline_usd`: the same usage priced on `baselineModel`, and for a failed request the
  upstream's error message). A `req` number pairs each `route`
  line with its `done` line. A `deciding` line marks each Jev call before its answer arrives, and a `config` line at
  startup and after every reload lists the tiers, Jev's options and each target's model and host, never keys.
- **Report.** `jev-router report [<log.jsonl>]` summarizes a log: requests and sessions, spend per model, cost
  against the baseline and the savings, and Jev's call count, fallback rate, p50 and p95 latency and cost. Without an
  argument it reads `logFile` from the config, or, when that isn't set, the log that `launch` writes
  (`~/.local/state/jev-router/router.log`). Lines that aren't JSON are skipped, so a mixed service log works.
- **Health.** `GET /healthz` returns the version, uptime, the session count, active requests, and each Jev channel's
  calls, errors, last error and circuit state. It needs no token.
- **State.** Decisions persist in `stateFile`, so a restart doesn't move live sessions to another model. Entries
  expire after seven days, and the file is compacted to one line per session at startup.
- **Signals.** `SIGHUP` re-reads and re-validates the config; if the new config is invalid, the old one stays in
  effect. `SIGTERM` and `SIGINT` stop new connections and wait up to 30 seconds for streams in flight.
- **Validation.** A bad config stops the router at startup with every problem listed.

```bash
jev-router report ~/.local/state/jev-router/router.log
curl -s http://127.0.0.1:4000/healthz
pgrep -f jev-router    # the router's process ID
kill -HUP <pid>        # reload its config
```

## CLI

```text
jev-router [serve] [--config <file>] [--host <h>] [--port <n>] [--ui [<host>:]<port>]
jev-router launch claude [--config <file>] [--port <n>] [--] [claude args…]
jev-router launch codex  [--config <file>] [--port <n>] [--] [codex args…]
jev-router env claude|codex [--config <file>] [--port <n>]   # eval "$(jev-router env claude)"
jev-router doctor [--config <file>] [--live]                  # --live makes one Jev call (~$0.00003)
jev-router init [--anthropic-only] [--force]                  # writes ~/.config/jev-router/config.json
jev-router report [<log.jsonl>]
jev-router ui [<log.jsonl>] [--port <n>]                      # live view on http://127.0.0.1:4100
jev-router version | help
```

`JEV_ROUTER_CLAUDE_BIN` and `JEV_ROUTER_CODEX_BIN` point `launch` at a specific `claude` or `codex` binary.

## Configuration

The router reads the first config it finds:

1. the file passed with `--config`
1. `JEV_ROUTER_CONFIG`
1. `$XDG_CONFIG_HOME/jev-router/config.json` (`~/.config/jev-router/config.json` by default)
1. the packaged [`config/default.json`](config/default.json)

`jev-router init` writes the packaged config to `~/.config/jev-router/config.json` for you to edit (`--anthropic-only`
starts from [`config/anthropic-only.json`](config/anthropic-only.json)). [docs/configuration.md](docs/configuration.md)
documents every key, its default and its validation.

| Key | Meaning |
| --- | --- |
| `tiers`, `defaultTier` | Tier names, cheapest first, and the tier a new session gets when Jev can't decide |
| `policy.mode` | `ratchet` (default) re-decides at each human message and only moves up; `sticky` decides once per session |
| `policy.accept` | Minimum probability per tier. Cheap tiers need more; below it, the more capable of the top two wins |
| `policy.sensitiveOverride`, `policy.claimGuard` | Guard thresholds |
| `policy.maxProvisional`, `policy.idleResetMinutes`, `policy.failClosed` | Retries after Jev failures, the idle reset, and whether unvetted sessions use trusted targets |
| `jev.channels` | Ordered System One channels, each with `baseUrl`, `model` (pin a version such as `jev-1.13.0`), `keyEnv` and `timeoutMs` |
| `jev.deadlineMs`, `jev.requestChars` | The total Jev budget per decision, and the size cap for the latest message |
| `jev.question`, `jev.options` | The rubric: one choice question with `what`, `examples` and `not_for` per option, and each option's `tier` |
| `surfaces.<anthropic\|openai>.<tier\|side\|trusted>` | Targets: `url`, `model`, `auth` (`x-api-key` or `bearer`), `keyEnv`, `clientAuth`, `trusted`, `countTokens`, `omit`, `maxOutputTokens`, `foldSystemMessages` |
| `prices`, `baselineModel` | USD per million tokens for the cost ledger, and the model savings are measured against |
| `sideCallModel`, `pinOnModelChange`, `modelPins` | Background-call detection, and model family to tier for `/model` switches |
| `host`, `port`, `token`, `allowedHosts`, `allowedOrigins`, `maxBodyBytes`, `stateFile`, `logFile` | Server settings |

| Environment variable | Meaning |
| --- | --- |
| `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY` | Jev channel keys (the shipped channels' `keyEnv`) |
| `OLLAMA_API_KEY`, `OPENAI_API_KEY` | Upstream keys for Ollama Cloud and OpenAI |
| `ANTHROPIC_API_KEY` | Optional. Without it, Claude Code's own login goes to Anthropic |
| `JEV_ROUTER_CONFIG` | Config file, after `--config` |
| `JEV_ROUTER_HOST`, `JEV_ROUTER_PORT` | Listen address, overriding the config |
| `JEV_ROUTER_TOKEN` | Shared secret clients send as `x-jev-router-token`; required for a non-loopback address |
| `JEV_ROUTER_TIER` | Pin every session to one tier |
| `JEV_ROUTER_CLAUDE_BIN`, `JEV_ROUTER_CODEX_BIN` | The `claude` and `codex` binaries `launch` runs |
| `JEV_BASE_URL`, `JEV_MODEL`, `JEV_API_KEY` | Add an extra System One channel in front of the configured ones |

## Evaluation

`npm run eval` measures Jev as the router uses it (the same state, questions, channels and policy) on 58 labeled
coding-agent prompts: 48 base prompts, 6 prompt-injection variants and 4 firewall probes. It reports accuracy,
under-routing with a 95% Wilson bound, calibration, injection downgrades, latency, cost, and a sweep of the `fast`
threshold. A live run needs a Jev key and costs about $0.002; `npm run eval:mock` checks the harness without one.

The shipped thresholds are starting values that haven't been tuned on real Jev answers yet, and 58 prompts is a
starter set. [docs/evaluation.md](docs/evaluation.md) covers the metrics, how to tune `policy.accept`, and the
sample sizes to aim for.

## Development

```bash
npm ci
npm run check   # Biome, tsc, markdownlint, then the tests with coverage thresholds
```

The router itself has zero runtime dependencies. The dev tools are [Biome](https://biomejs.dev) for linting and
formatting, TypeScript 7 (`tsc`) to type-check the JSDoc-annotated JavaScript without emitting anything,
[markdownlint-cli2](https://github.com/DavidAnson/markdownlint-cli2) for the docs, and `node:test` with Node's
built-in coverage.

| Script | What it runs |
| --- | --- |
| `npm run lint` | `biome check --error-on-warnings .` |
| `npm run format` | `biome check --write .` |
| `npm run typecheck` | `tsc -p tsconfig.json`: TypeScript 7, `checkJs` in strict mode on the JSDoc types |
| `npm run lint:md` | `markdownlint-cli2` |
| `npm test` | `node --test test/*.test.mjs`: offline, against mock upstreams and a mock Jev |
| `npm run test:coverage` | The tests with coverage thresholds on `src/**`: lines 85%, branches 75%, functions 85% |
| `npm run check` | `lint`, `typecheck`, `lint:md` and `test:coverage`, the gate CI runs |
| `npm run test:live` | Three live Anthropic calls with Jev mocked; needs Anthropic credentials |
| `npm run eval` / `npm run eval:mock` | The Jev evaluation on 58 labeled prompts, live or with a keyword stand-in |
| `npm start` | Starts the router (`jev-router serve`) |

CI runs `npm ci` and `npm run check` on Node.js 22 and 24, and lints the workflows with actionlint.

| Path | Purpose |
| --- | --- |
| `bin/jev-router.mjs`, `src/cli.mjs` | The command-line entry point |
| `src/router.mjs` | The server, the routing pipeline, forwarding, and `report` |
| `src/config.mjs` | Config defaults and validation |
| `src/jev.mjs` | Jev's state, the questions, the channels, and the policy |
| `src/messages.mjs` | Human turns, harness wrappers and tier tags |
| `src/secrets.mjs` | The secret scanner and redaction |
| `src/sessions.mjs` | The persistent session store |
| `src/usage.mjs` | The usage tap and prices |
| `src/ui.mjs`, `ui/` | The live view: the log follower and server, and the page |
| `config/` | The packaged configs |
| `examples/` | Claude Code environment file, Codex profile and model catalog |
| `eval/` | The evaluation harness and labeled prompts |
| `sbx/jev-router-kit/` | A Docker Sandboxes kit for the upstream credentials |
| `docs/` | [Activation](docs/activation.md), [configuration](docs/configuration.md), [design](docs/design.md), [evaluation](docs/evaluation.md), [Docker Sandboxes](docs/sandbox.md) |

[CONTRIBUTING.md](CONTRIBUTING.md) has the workflow, and [AGENTS.md](AGENTS.md) the conventions for coding agents.

## Status

The current release is 1.3.2. The offline suite covers the routing pipeline against mock upstreams and a mock Jev.
A live check on 2026-09-24 sent Claude Code's full request shape through the router to Anthropic, with Jev mocked:
Haiku 4.5 (with its `omit` list, and `max_tokens` lowered from Claude Code's 128,000 to 64,000) and Sonnet 5 both
answered 200, the streams were byte-exact, and the router made one Jev call per human message.

Not verified yet, because it needs keys: real Jev answers (so the thresholds are untuned), Ollama Cloud and OpenAI
as live upstreams, and full Claude Code and Codex sessions, especially Codex's file edits on Ollama models.
[docs/sandbox.md](docs/sandbox.md) walks through each of these in a Docker Sandbox.

## Related projects

- [LiteLLM](https://docs.litellm.ai/docs/auto_router/setup): the LiteLLM gateway's auto router can classify
  requests with Jev (`classifier_type: jev`, since LiteLLM 1.102.1), as part of a general gateway with virtual keys,
  spend tracking and protocol translation.
- [Switchboard](https://github.com/ruban-24/switchboard): a Claude Code and Codex wrapper with a local proxy. Jev
  assesses the task, and a local policy picks the model and effort within the client's own vendor for the whole
  conversation.
- [Jevonian](https://github.com/xinyao27/jevonian): a local proxy with a dashboard and a cost ledger that routes
  Chat Completions, Messages and Responses clients across many providers.
- [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router): `jev-claude` and `jev-codex` run each CLI
  behind a loopback proxy and pick a model within its vendor on each fresh user turn. It's the `jev-router` package
  on npm, and it isn't related to this project.

## License

Apache-2.0. See [LICENSE](LICENSE). [NOTICE](NOTICE) credits the Codex system prompt in
[`examples/codex/jev-models.json`](examples/codex/jev-models.json), which comes from
[openai/codex](https://github.com/openai/codex) under Apache-2.0.
