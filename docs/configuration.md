# Configuration reference

jev-router reads one JSON file. This page lists every key with its default and its validation, the environment
variables, and the two packaged configs. The source of truth is `validateConfig` in
[`src/config.mjs`](../src/config.mjs) and the shipped [`config/default.json`](../config/default.json).

## Where the config comes from

The router uses the first of these that exists:

1. the file passed with `--config <file>`
1. the file in `JEV_ROUTER_CONFIG`
1. `$XDG_CONFIG_HOME/jev-router/config.json`, which is `~/.config/jev-router/config.json` when `XDG_CONFIG_HOME` is
   unset
1. the packaged [`config/default.json`](../config/default.json)

`jev-router init` writes the packaged default to `~/.config/jev-router/config.json` as a starting point, and
`jev-router init --anthropic-only` writes [`config/anthropic-only.json`](../config/anthropic-only.json) instead. It
doesn't overwrite an existing file unless you pass `--force`.

The file is plain JSON, without comments. The router validates it at startup and exits with every problem listed,
and again on `SIGHUP`, where an invalid file leaves the running config in place. Keys the router doesn't know are
ignored, not rejected, so a misspelled optional key keeps its default without a warning.

## Packaged configs

| File | Claude Code | Codex CLI |
| --- | --- | --- |
| [`config/default.json`](../config/default.json) | `fast`: Ollama Cloud `glm-5.3-flash`. `balanced` and `trusted`: Anthropic `claude-sonnet-5`. `frontier`: Anthropic `claude-opus-5-5`. `side`: Anthropic `claude-haiku-4-5` | `fast`: Ollama Cloud `glm-5.3-flash`. `balanced`: Ollama Cloud `kimi-k2.7-code`. `frontier`: OpenAI `gpt-6-astra`. `trusted`: OpenAI `gpt-6-sol` |
| [`config/anthropic-only.json`](../config/anthropic-only.json) | Like the default, except that `fast` is Anthropic `claude-haiku-4-5`, with the same `omit` list as `side` | Same as the default |

Both configs share the policy, the Jev channels, the rubric, the prices and the baseline. The OpenAI model names come
from Codex's bundled model catalog; check them against your account.

## Server keys

| Key | Default | Validation | Meaning |
| --- | --- | --- | --- |
| `host` | `"127.0.0.1"` | A non-loopback address needs a token, or the router refuses to start | Listen address. `--host` and `JEV_ROUTER_HOST` override it |
| `port` | `4000` | Integer from 1 to 65535 | Listen port. `--port` and `JEV_ROUTER_PORT` override it |
| `token` | none | none | Shared secret that every proxied request must carry as `x-jev-router-token`. `JEV_ROUTER_TOKEN` overrides it. `/healthz` doesn't need it |
| `allowedHosts` | `[]` | Must be an array | `Host` header values (`host:port`) accepted besides `127.0.0.1`, `localhost` and `[::1]` on the router's port |
| `allowedOrigins` | none | none | `Origin` header values to accept. Any request with another `Origin` gets a 403, which keeps browser tabs out |
| `maxBodyBytes` | `33554432` (32 MiB) | none | Larger request bodies get a 413 |
| `maxSessions` | `10000` | none | Sessions kept in memory and in the state file; the least recently used ones are dropped first |
| `stateFile` | `"~/.local/state/jev-router/sessions.jsonl"` | A leading `~/` is expanded | Where decisions persist across restarts. `null` keeps them in memory only |
| `logFile` | `null` | A leading `~/` is expanded | A file to append the JSON log lines to, besides stdout (mode 0600) |

The state file is created with mode 0600 in a directory with mode 0700. The router appends a JSON line whenever a
session's entry changes, keyed by a SHA-256 hash of the session ID: tier, trust flag, provisional state, turn count,
the client's model name, the last upstream host, and a hash of the human message where the provider changed. Entries
older than seven days are dropped, and the file is rewritten to one line per live session at startup. It never holds
prompt text.

## Tiers and routing rules

| Key | Default | Validation | Meaning |
| --- | --- | --- | --- |
| `tiers` | none, required | A non-empty list of strings | Tier names, cheapest first. Shipped: `["fast", "balanced", "frontier"]` |
| `defaultTier` | none, required | One of `tiers` | The tier a new session gets when Jev can't decide, and the reference a fresh session's decision is compared against. Shipped: `"balanced"` |
| `sideCallModel` | `"haiku"` | none | A case-insensitive regular expression. When a request carries no request class, a matching model name marks it as a background call |
| `pinOnModelChange` | `true` | none | When the client switches to another model family (for example `/model opus` in Claude Code), pin the session to that family's tier |
| `modelPins` | `{}` | Each value must be one of `tiers` | Model family to tier. Families are `fable`, `opus`, `sonnet` and `haiku`. Shipped: `fable` and `opus` to `frontier`, `sonnet` to `balanced`, `haiku` to `fast` |

## policy

| Key | Default | Validation | Meaning |
| --- | --- | --- | --- |
| `policy.mode` | `"ratchet"` | `"ratchet"` or `"sticky"` | `ratchet` asks Jev at every new human message and only moves a session up. `sticky` asks once per session |
| `policy.accept` | `0.6` for every tier | Each value a probability from 0 to 1, keyed by a name in `tiers` | The probability Jev's most likely tier needs to be taken as is. Shipped: `fast` 0.85, `balanced` 0.6, `frontier` 0.3 |
| `policy.sensitiveOverride` | `0.7` | A probability | When `alters_sensitive_state` reaches this, the request goes to the top tier |
| `policy.claimGuard` | `0.5` | A probability | When `routing_claim_present` reaches this, the decision can't go below the reference tier |
| `policy.maxProvisional` | `3` | none | How many failed Jev attempts a new session allows before its fallback tier sticks |
| `policy.idleResetMinutes` | `10` | none | After this many minutes without traffic, the next human message is decided afresh, because the prompt cache has most likely expired |
| `policy.failClosed` | `false` | none | Keep provisional sessions, which Jev hasn't answered for yet, on the `trusted` target |

How the policy turns Jev's answer into a tier, in order:

1. Option probabilities are summed per tier (`mechanical` to `fast`, `routine` to `balanced`, `complex` and `deep` to
   `frontier` in the shipped rubric).
1. If the most likely tier reaches its `accept` value, it's taken (`reason: jev`). Otherwise, if the second most
   likely tier is more capable and has any probability, that one is taken (`reason: jev-escalated`).
1. `alters_sensitive_state` at or above `sensitiveOverride` forces the top tier (`reason: risk-override`).
1. `routing_claim_present` at or above `claimGuard` lifts a decision below the reference tier to the reference
   (`reason: claim-guard`).
1. In an ongoing session, a result at or below the current tier keeps the current tier (`reason: jev-keep`), and a
   higher one is an upgrade (`reason: upgrade:<reason>`).

A session is decided afresh, without the ratchet, when it's new, still provisional, idle for longer than
`idleResetMinutes`, or its history shrank since the last request (compaction, or a fork of the conversation). The
reference tier is `defaultTier` for a fresh decision and the current tier otherwise.

When no Jev channel answers, a new session gets `defaultTier` and stays provisional: Jev is asked again on its next
human message, up to `maxProvisional` attempts (`reason: fallback:default`). An ongoing session keeps its tier
(`reason: fallback:keep`). When no channel has a key at all, every new session gets `defaultTier`
(`reason: no-jev`), and the log carries a warning once.

## jev

| Key | Default | Validation | Meaning |
| --- | --- | --- | --- |
| `jev.deadlineMs` | `2500` | none | The total time for one decision, across channels and retries |
| `jev.requestChars` | `4000` | none | Size cap for the latest human message in Jev's state. Longer text keeps a quarter of the cap from its start and the rest from its end, where the question usually is |
| `jev.stripCode` | `true` | none | Accepted, but the router doesn't read it yet: code blocks are always replaced by a one-line summary |
| `jev.guards` | `true` | none | Ask the two guard questions, `alters_sensitive_state` and `routing_claim_present`, in the same request as the tier question |
| `jev.channels` | `[]` | Must be an array. Each channel needs a `name`, an http(s) `baseUrl`, a `model` and a `keyEnv` | System One channels, tried in order |
| `jev.channels[].timeoutMs` | `1200` | none | Timeout for one attempt on this channel |
| `jev.question` | none, required | A non-empty string | The instructions of the tier question |
| `jev.options` | none, required | At least two options, each with a `tier` from `tiers` | The tier question's options |

The router calls `POST {baseUrl}/v1/systemone` with `Authorization: Bearer <key>` and a body of `model`, `state` and
`questions`. A channel is used only when the environment variable named by its `keyEnv` is set, and its key is only
ever sent to its own `baseUrl`. The shipped channels:

| `name` | `baseUrl` | `model` | `keyEnv` |
| --- | --- | --- | --- |
| `typesafe` | `https://api.typesafe.ai` | `jev-1.13.0` | `TYPESAFE_API_KEY` |
| `openrouter` | `https://openrouter.ai/api` | `typesafe/jev-1.13` | `OPENROUTER_API_KEY` |

Pin a model version rather than an alias such as `jev-latest`: TypeSafe moves the alias when it ships a new version,
and thresholds tuned on one version don't carry over. `JEV_BASE_URL` and `JEV_API_KEY` add a channel named `env` in
front of the list, with `JEV_MODEL` as its model (default `jev-1.13.0`) and a 1,200 ms timeout. Any server that speaks
the System One API works there.

How the channels fail over, within `deadlineMs`:

- A response with status 408, 429, 500, 502, 503, 504 or 529 gets one retry on the same channel, after the server's
  `retry-after` delay (150 ms without one), if that still fits in the deadline.
- A 403 with an HTML body comes from the provider's edge firewall, not from the API. It gets one retry with a hardened
  state, in which URLs, file paths and command names become placeholders and shell metacharacters are removed.
- After a timeout or a network error, the channel is skipped for 30 seconds. After a 401, 402 or 403, it's skipped for
  5 minutes.
- Then the next channel is tried. When none answers, the policy falls back as described above.

Each option in `jev.options` has a `tier` and the fields Jev sees: in the shipped rubric, `what`, `examples` and
`not_for`. The router removes `tier` before sending, so Jev judges the work and never sees a tier or model name. The
option names (`mechanical`, `routine`, `complex`, `deep`) are sent, and their order stays fixed. After any change to
`jev.question` or `jev.options`, re-run the [evaluation](evaluation.md) before relying on the thresholds.

## surfaces

`surfaces` maps the router's two client protocols to upstream targets. `surfaces.anthropic` serves `/v1/messages`
and `/v1/messages/count_tokens` (Claude Code), and `surfaces.openai` serves `/v1/responses` (Codex). A surface needs
one target per name in `tiers`, plus:

- `trusted`, required when any tier's target isn't `trusted`. It serves sessions that contained a secret, and, with
  `failClosed`, provisional ones.
- `side`, optional, for background calls. Without it, background calls use the cheapest tier's target.

Validation reports a missing target for any tier, and a surface that routes some tier to an untrusted target
without a `trusted` target marked `"trusted": true`.

| Target key | Required | Validation | Meaning |
| --- | --- | --- | --- |
| `url` | yes | An http(s) URL | Upstream base URL. The request path and query string are appended |
| `model` | yes | A non-empty string | The model name written into the forwarded request |
| `auth` | yes | `"x-api-key"` or `"bearer"` | How the router sends its key |
| `keyEnv` | this or `clientAuth` | none | Environment variable that holds the key for this target |
| `clientAuth` | this or `keyEnv` | none | When the router has no key for this target, forward the client's own `authorization` or `x-api-key` header. Use it only for Anthropic, to keep a Claude login working |
| `trusted` | no | none | Trusted with secrets and with the client's full headers |
| `countTokens` | no | none | `false` answers `count_tokens` with a local 404 instead of forwarding the prompt to a counter with another tokenizer |
| `omit` | no | A list of strings | Fields to delete from the request body before forwarding. Dotted paths reach nested fields, for example `output_config.effort` |
| `maxOutputTokens` | no | A positive whole number | The most output tokens the model accepts. A larger `max_tokens` (or `max_output_tokens`) is lowered to it, and a thinking budget stays below it. Defaults to the measured limits of known Claude models: 64000 for `claude-haiku-4-5`, 128000 for `claude-sonnet-5`, `claude-opus-5-5` and `claude-fable-5-1`. Claude Code sizes `max_tokens` for the model it thinks it talks to, so a cheaper tier needs this |
| `foldSystemMessages` | no | `true` or `false` | Folds `role: "system"` messages inside `messages` into the user message each follows, as `<system-reminder>` text after its tool results; the tools they add (`tool_addition` blocks) join `tools`. Claude Code sends them to the Claude 5 family; Haiku 4.5 answers "role 'system' is not supported on this model". Defaults to `false` for `claude-sonnet-5`, `claude-opus-5-5` and `claude-fable-5-1`, and `true` for every other model |
| `omitBetas` | no | A list of strings | Beta flags to drop from the `anthropic-beta` header. Defaults to `["context-1m-2025-08-07"]` for `claude-haiku-4-5`: Claude Code asks for the 1M-context beta once its own model has a 1M window, and Haiku 4.5 answers "The long context beta is not yet available for this subscription" |

When `keyEnv` names a variable that's set, the router's key wins over the client's credential, so setting
`ANTHROPIC_API_KEY` bills every Anthropic request to that key instead of the Claude login.

An untrusted target (`trusted` unset or false) gets less of the request: secrets redacted anywhere in the body,
tool output included, only the `content-type`, `accept`, `anthropic-version`, `anthropic-beta`, `openai-beta` and
`user-agent` headers, and no `metadata`.

The shipped `omit` list, on `surfaces.anthropic.side` and on `fast` in the Anthropic-only config, removes the adaptive
`thinking`, `output_config.effort` and `context_management` that Claude Code sends for a current model. Haiku 4.5
rejects them with a 400. Ollama Cloud targets set `countTokens: false`, because Ollama Cloud has no `count_tokens`
endpoint.

## Prices and the baseline

| Key | Default | Validation | Meaning |
| --- | --- | --- | --- |
| `prices` | `{}` | none | USD per million tokens per model: `in`, `out`, and optionally `cacheRead` and `cacheWrite`, which fall back to `in` |
| `baselineModel` | none | none | Per surface, the model whose prices `baseline_usd` uses. Shipped: `{"anthropic": "claude-opus-5-5"}` |

Each `done` log line carries `cost_usd`, the request's usage priced on the model that served it, and `baseline_usd`,
the same usage priced on the surface's baseline model. `jev-router report` adds them up and shows the difference as
the savings. A model name with a date suffix (`claude-haiku-4-5-20251001`) falls back to the undated price entry. A
response from a model without a price counts as `unpriced_responses` in the report.

The shipped prices, per million tokens:

| Model | Input | Output | Cache read | Cache write |
| --- | --- | --- | --- | --- |
| `claude-haiku-4-5` | $1 | $5 | $0.10 | $1.25 |
| `claude-sonnet-5` | $2 | $10 | $0.20 | $2.50 |
| `claude-opus-5-5` | $4 | $20 | $0.20 | $5 |
| `claude-fable-5-1` | $10 | $50 | $0.25 | $12.50 |
| `glm-5.3-flash` | $0.15 | $0.50 | $0.03 | same as input |
| `kimi-k2.7-code` | $0.95 | $4 | $0.19 | same as input |

The OpenAI models have no shipped prices. Add them to `prices` to include Codex's frontier and trusted tiers in the
ledger.

## Environment variables

| Variable | Read by | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | The shipped `typesafe` channel | Jev through TypeSafe |
| `OPENROUTER_API_KEY` | The shipped `openrouter` channel | Jev through OpenRouter |
| `OLLAMA_API_KEY` | Ollama Cloud targets | Sent as a bearer key |
| `OPENAI_API_KEY` | OpenAI targets | Sent as a bearer key |
| `ANTHROPIC_API_KEY` | Anthropic targets | Optional. When it's unset, Claude Code's own credential goes to Anthropic |
| `JEV_ROUTER_CONFIG` | Config lookup | The config file, after `--config` |
| `XDG_CONFIG_HOME` | Config lookup | Base directory for `jev-router/config.json` |
| `JEV_ROUTER_HOST`, `JEV_ROUTER_PORT` | `serve` | Listen address, overriding `host` and `port` |
| `JEV_ROUTER_TOKEN` | The router, `launch`, `env` | Shared secret sent as `x-jev-router-token`, overriding `token`. Required for a non-loopback address |
| `JEV_ROUTER_TIER` | The router | Pins every main-loop request of every session to this tier. An unknown tier name is logged and ignored |
| `JEV_ROUTER_CLAUDE_BIN`, `JEV_ROUTER_CODEX_BIN` | `launch` | The `claude` and `codex` binaries to run |
| `JEV_BASE_URL`, `JEV_API_KEY`, `JEV_MODEL` | The Jev client | Add a channel in front of `jev.channels`. Both `JEV_BASE_URL` and `JEV_API_KEY` must be set |

The key variables are the `keyEnv` names in the shipped configs. A config can name any variable instead.

## Validation messages

Every problem is reported at once, for example:

```text
Invalid router config:
  - port must be an integer between 1 and 65535
  - defaultTier "Balanced" is not one of tiers
  - policy.accept.fast must be a probability
  - surfaces.anthropic has no target for tier "frontier"
```

| Check | Message |
| --- | --- |
| `port` | `port must be an integer between 1 and 65535` |
| `allowedHosts` | `allowedHosts must be an array of host[:port] strings` |
| `tiers` | `tiers must list tier names, cheapest first` |
| `defaultTier` | `defaultTier "…" is not one of tiers` |
| `policy.mode` | `policy.mode must be "ratchet" or "sticky"` |
| `policy.accept` | `policy.accept names unknown tier "…"`, `policy.accept.<tier> must be a probability` |
| Guard thresholds | `policy.sensitiveOverride must be a probability`, `policy.claimGuard must be a probability` |
| `jev.channels` | `jev.channels must be an array`, `jev.channels[i].name is required`, `….baseUrl must be an http(s) URL`, `….model is required`, `….keyEnv is required` |
| `jev.question`, `jev.options` | `jev.question is required`, `jev.options needs at least two options`, `jev.options.<name>.tier must be one of tiers` |
| `surfaces` | `surfaces is required`, `surfaces.<surface> has no target for tier "…"`, `… needs a trusted target marked "trusted": true` |
| Targets | `….url must be an http(s) URL`, `….model is required`, `….auth must be "x-api-key" or "bearer"`, `… needs keyEnv or clientAuth`, `….omit must be a list of field paths`, `….maxOutputTokens must be a positive whole number`, `….foldSystemMessages must be true or false`, `….omitBetas must be a list of beta names` |
| `modelPins` | `modelPins.<family> must be one of tiers` |
