# Changelog

All notable changes to jev-router are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.1] - 2026-09-24

### Fixed

- Claude Code turns routed to Haiku 4.5 failed with a 400: Claude Code asks for `max_tokens: 128000`, sized for the
  Opus 5.5 it believes it talks to, and Haiku 4.5 accepts at most 64000. The router now lowers `max_tokens` (and
  `max_output_tokens`) to what the target's model accepts, keeps a thinking budget below it, and says so in the
  `x-jev-max-tokens` header and the `capped_max_tokens` field of the `done` line. The limits of Haiku 4.5 and the
  Claude 5 family are built in; a target's new `maxOutputTokens` overrides them.

### Added

- The `done` line carries the upstream's error message for a failed request, and the live view shows it.

## [1.2.0] - 2026-09-24

### Added

- `jev-router serve --ui [<host>:]<port>` (or `JEV_ROUTER_UI`): the router serves its live view itself, on its own
  port, and feeds it every log entry in-process, so no log file is needed. Config reloads show up in the view.
  Listening on `0.0.0.0` lets a forwarded port (`sbx ports`) reach it from outside a Docker Sandbox, with a warning
  on stderr. A view that can't listen is reported, and routing goes on without it.

### Changed

- The live view checks only the host name of the `Host` header, not its port, so a port forwarded under another
  number works. It still answers only loopback names and the address it listens on.

## [1.1.0] - 2026-09-24

### Added

- `jev-router ui [<log.jsonl>] [--port <n>]`: a live, animated view of routing in the browser on
  `http://127.0.0.1:4100`. It shows Jev's category and probabilities for each human message, the tier and model the
  router picked and why, every request's path from the client through Jev to the model, a timeline with tokens and
  cost, each session's tier history, and spend against the baseline. It follows the log by polling, so it also works
  across a Docker Sandbox's shared workspace folder.
- Log lines for the view: `req` pairs each `route` line with its `done` line, `deciding` marks a Jev call before its
  answer, and `config` lists the tiers, Jev's options and each target's model and host (never keys) at startup and
  after every reload.

## [1.0.0] - 2026-09-24

First release.

### Added

- A pass-through router for Claude Code (`/v1/messages`, `/v1/messages/count_tokens`) and the Codex CLI
  (`/v1/responses`). It changes only `model`, the credential and the fields a target rejects, and streams responses
  back byte for byte.
- Tier decisions by Jev on new human messages only. Tool-loop steps, subagents, compaction and background calls
  follow the session's tier, and a session only moves up (`policy.mode: "ratchet"`) or is decided once
  (`"sticky"`).
- A small, scrubbed Jev state, and one tier question with guards for sensitive operations and routing claims.
  Asymmetric per-tier thresholds escalate to the more capable tier when Jev is unsure.
- Jev channel failover (TypeSafe, then OpenRouter, plus an optional `JEV_BASE_URL` channel), one retry within a
  deadline, circuit breakers, a hardened retry after a firewall block, and a provisional fallback to the default tier.
- Deterministic pins and tags: the `x-jev-tier` header, `JEV_ROUTER_TIER`, `#tier` as the first or last typed word,
  and `/model` switches to another model family.
- A secret scanner on every human message that keeps a session on trusted upstreams. Untrusted upstreams get
  redacted bodies, a minimal set of headers and no `metadata`.
- Provider-aware stripping of signed reasoning when a session moves to another upstream host.
- Per-target `omit` lists for fields a model rejects, verified live against Haiku 4.5.
- Loopback binding with `Host`, `Origin` and content-type checks, an optional `x-jev-router-token`, and a refusal
  to listen on other addresses without a token.
- Persistent session state, JSON-line logs with token usage, cost and baseline cost, `jev-router report`,
  `GET /healthz`, config reload on `SIGHUP` and a drain on `SIGTERM`.
- Config validation that lists every problem at startup, and two packaged configs: `config/default.json` and
  `config/anthropic-only.json`.
- The `jev-router` CLI: `serve`, `launch claude`, `launch codex`, `env`, `doctor`, `init`, `report`, `version` and
  `help`.
- Client examples for Claude Code and Codex, including a Codex model catalog that carries Codex's own system prompt.
- A Docker Sandboxes kit for the upstream credentials.
- An offline test suite with mock upstreams and a mock Jev, a live Anthropic check, and a Jev evaluation harness with
  58 labeled prompts.
- Biome, TypeScript (`checkJs`) and markdownlint checks, and CI on Node.js 22 and 24 with actionlint.
- Documentation: activation, configuration reference, design notes, evaluation, and a Docker Sandboxes guide.

[Unreleased]: https://github.com/dirien/jev-router/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/dirien/jev-router/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/dirien/jev-router/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/dirien/jev-router/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/dirien/jev-router/releases/tag/v1.0.0
