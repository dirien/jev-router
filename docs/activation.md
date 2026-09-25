# Activating jev-router

This guide connects Claude Code and the Codex CLI to jev-router on your own machine, keeps the router running as a
service, and shows how to check that routing works and how to turn it off again. It assumes you installed jev-router
with `npm install -g github:dirien/jev-router#semver:^1` and ran `jev-router init`, as in the README's
[Quick start](../README.md#quick-start). The examples use the default address, `http://127.0.0.1:4000`.
[configuration.md](configuration.md) covers the config itself.

## Keys

The router reads its keys from environment variables. On a plain machine, keep them in an env file that only you
can read, `~/.config/jev-router/env`, with one `KEY=value` line per key:

```bash
touch ~/.config/jev-router/env && chmod 600 ~/.config/jev-router/env
```

```text
TYPESAFE_API_KEY=...
OLLAMA_API_KEY=...
OPENAI_API_KEY=...
```

| Variable | What it's for |
| --- | --- |
| `TYPESAFE_API_KEY` | Jev through TypeSafe |
| `OPENROUTER_API_KEY` | Jev through OpenRouter: a failover for TypeSafe, or instead of it |
| `OLLAMA_API_KEY` | The tiers on Ollama Cloud: Claude Code's `fast` tier in the default config, and Codex's `fast` and `balanced` tiers |
| `OPENAI_API_KEY` | Codex's `frontier` and `trusted` tiers |
| `ANTHROPIC_API_KEY` | Optional. Without it, the router passes Claude Code's own login to Anthropic. With it, the key pays for every Anthropic request |

How the router loads the file:

- `serve`, `launch`, `env` and `doctor` take `--env-file <file>`. Without the flag, they load the file that
  `JEV_ROUTER_ENV_FILE` names, if any.
- A variable that's already set in the environment wins over the file.
- A leading `~` is expanded, because launchd and systemd start the router without a shell.
- The router warns when other users can read or change the file, and prints the `chmod` that fixes it.
- Proxy settings (`HTTPS_PROXY`, `NODE_USE_ENV_PROXY` and the like) and `NODE_EXTRA_CA_CERTS` have no effect from the
  file, because Node reads them only when it starts. Set them in the environment the router starts with; the router
  warns when the file sets them.
- A missing file stops the command before jev-router runs: Node checks the path itself, prints
  `node: <path>: not found`, and exits with status 9.
- The file is read once, at startup. After you change a key, restart the router; `SIGHUP` reloads only the config.
- `launch` keeps the file's variables out of the agent's environment, so the commands Claude Code or Codex runs don't
  see the keys from the file.

The file can also hold the router's other settings, such as `JEV_ROUTER_TOKEN` or `JEV_ROUTER_UI_TOKEN`. If you'd
rather keep the keys in your shell environment, export them before you start the router, and leave out
`--env-file`.

## Claude Code

Every Claude Code setup below sets the same variables:

| Variable | Value | Why |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:4000` | Sends Claude Code's API traffic to the router instead of Anthropic |
| `CLAUDE_CODE_GATEWAY_HINT_HEADERS` | `1` | Labels each request as main loop, subagent, compaction, workflow or background work (Claude Code 2.1.273 and later), so only a person's messages decide the tier |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `160000` | Claude Code can't learn the routed model's context window through a gateway. 160,000 tokens compacts before the smallest window among the tiers |
| `ENABLE_TOOL_SEARCH` | `true` | Claude Code turns MCP tool search off when `ANTHROPIC_BASE_URL` isn't Anthropic's, and then sends every MCP tool's definition with every request. In a live test with a few MCP servers, that was about 200,000 tokens per request, more than the compaction window, so Claude Code compacted on every message. The router forwards tool search as is |
| `ANTHROPIC_CUSTOM_HEADERS` | `x-jev-router-token: <token>` | Only when the router has a token (`JEV_ROUTER_TOKEN`) |

None of them is an API key. Claude Code keeps using your Claude login, and the router passes that credential to
Anthropic and to no other host. Requests that the router sends to Ollama Cloud or OpenAI use the router's own keys.

### One-shot launch

```bash
jev-router launch claude --env-file ~/.config/jev-router/env                 # router on 127.0.0.1:4000
jev-router launch claude --env-file ~/.config/jev-router/env --port 4001     # another port
jev-router launch claude --env-file ~/.config/jev-router/env -- --continue   # arguments after -- go to claude
```

`launch claude` reuses a router that already answers on the port. If none does, it starts one inside its own
process, with the keys from the env file, and that router logs to `~/.local/state/jev-router/router.log`. Then it runs
`claude` with the variables above and exits with Claude Code's exit code. Set `JEV_ROUTER_CLAUDE_BIN` to run a
specific `claude` binary.

A router that `launch` started lives only as long as that `launch` process. If you run several Claude Code sessions
at once, start the router separately (`jev-router serve`, or a [service](#run-the-router-as-a-service)), so that
closing the first session doesn't take the router away from the others.

### Environment for the current shell

With the router already running in another terminal or as a service, load the variables into your shell and start
Claude Code as usual:

```bash
jev-router serve --ui 4100 --env-file ~/.config/jev-router/env   # terminal 1, unless it runs as a service
eval "$(jev-router env claude)"                                  # terminal 2
claude
```

`jev-router env claude` prints `export` lines for the variables in the table, and warns when nothing answers on the
port yet. Pass the same `--port`, `--config` or `--env-file` as the router uses, so the address and the token match.
Every `claude` you start from that shell then goes through the router. To stop, open a new shell or unset the
variables:

```bash
unset ANTHROPIC_BASE_URL CLAUDE_CODE_GATEWAY_HINT_HEADERS CLAUDE_CODE_AUTO_COMPACT_WINDOW ENABLE_TOOL_SEARCH ANTHROPIC_CUSTOM_HEADERS
```

[`examples/claude-code.env`](../examples/claude-code.env) holds the same settings as a file you can `source`, plus a
cap on output tokens that `env claude` doesn't set, and commented-out lines for a token or a tier pin. It ships with
the package:

```bash
source "$(npm root -g)/@ediri/jev-router/examples/claude-code.env"
```

### Persistent settings.json

To send every Claude Code session through the router, add an `env` block to `~/.claude/settings.json`, keeping the
keys the file already has:

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

The values must be strings. If the router has a token, add `"ANTHROPIC_CUSTOM_HEADERS": "x-jev-router-token: <token>"`
and make the file readable only by you (`chmod 600 ~/.claude/settings.json`). To route only one project, put the
block in that project's `.claude/settings.local.json` instead.

Claude Code now depends on the router. While nothing listens on the port, every request fails with a connection
error, so [run the router as a service](#run-the-router-as-a-service). A value in `settings.json` wins over the
same variable in your shell ([Claude Code docs](https://code.claude.com/docs/en/llm-gateway-connect)), so `unset`
doesn't bypass it.

`jev-router doctor` reads the block (without changing the file). When `ANTHROPIC_BASE_URL` there, or in your shell,
points at the router, it names each of the other three variables that's missing.

To undo it, delete those keys from the `env` block and restart Claude Code. With `jq`:

```bash
jq 'del(.env.ANTHROPIC_BASE_URL, .env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, .env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, .env.ENABLE_TOOL_SEARCH,
  .env.ANTHROPIC_CUSTOM_HEADERS)' ~/.claude/settings.json > ~/.claude/settings.json.new \
  && mv ~/.claude/settings.json.new ~/.claude/settings.json
```

## Codex CLI

### Codex launch

```bash
jev-router launch codex --env-file ~/.config/jev-router/env           # writes or refreshes the profile, then runs codex --profile jev
jev-router launch codex --env-file ~/.config/jev-router/env --force   # rewrites the profile first
```

`launch codex` writes the `jev` profile to `~/.codex/jev.config.toml` (`$CODEX_HOME/jev.config.toml` when
`CODEX_HOME` is set). A profile it wrote and nobody edited is refreshed whenever the router's port or token changes; a
profile you edited is kept, with a note, and `--force` replaces it. Like `launch claude`, it reuses a router on the
port or starts one. Arguments after `--` go to `codex`, and `JEV_ROUTER_CODEX_BIN` runs a specific binary. Profile
files need Codex 0.134.0 or newer.

### Codex profile by hand

The profile is [`examples/codex/jev.config.toml`](../examples/codex/jev.config.toml):

1. Copy it to `~/.codex/jev.config.toml`.
1. Set `model_catalog_json` to the absolute path of
   [`examples/codex/jev-models.json`](../examples/codex/jev-models.json).
1. Run `codex --profile jev`.

Both files ship with the package. This does the first two steps:

```bash
examples="$(npm root -g)/@ediri/jev-router/examples/codex"
mkdir -p ~/.codex
sed "s#/absolute/path/to/jev-models.json#$examples/jev-models.json#" "$examples/jev.config.toml" \
  > ~/.codex/jev.config.toml
```

What the profile sets, and why:

- `model = "jev-auto"`: Codex shapes every request (tool types, shell type, parallel tool calls) from the model's
  catalog entry. `jev-auto` is one virtual model whose entry every routed model can handle, and the router picks the
  real model behind it. The entry also carries Codex's own system prompt; an empty one would drop Codex's
  instructions without an error.
- `base_url = "http://127.0.0.1:4000/v1"` and `wire_api = "responses"`, the only wire API current Codex accepts.
- `supports_websockets = false`: WebSockets carry `previous_response_id`, which is stateful, and Ollama Cloud only
  serves stateless Responses.
- `web_search = "disabled"`: Ollama Cloud has no built-in web search on `/v1/responses`.

If the router has a token, let Codex send it from the environment, so it stays out of the file. Add this under
`[model_providers.jev]`:

```toml
env_http_headers = { "x-jev-router-token" = "JEV_ROUTER_TOKEN" }
```

To pin every session started with this profile to one tier, add `http_headers = { "x-jev-tier" = "frontier" }` in
the same table.

## Run the router as a service

A service keeps one router running for all your clients, independent of any terminal, and restarts it if it fails.
Session state persists in `~/.local/state/jev-router/sessions.jsonl`, so a restart doesn't move live sessions to
another model.

The package ships a template for each system, under `$(npm root -g)/@ediri/jev-router/examples/service/`. Both run
`jev-router serve --ui 4100 --env-file ~/.config/jev-router/env --log-file ~/.local/state/jev-router/router.log`:
the router on `http://127.0.0.1:4000`, the live view on `http://127.0.0.1:4100`, and the keys from your env file. The
commands below come from each template's header.

`jev-router` starts with `#!/usr/bin/env node`, and a service reads neither your shell profile nor its `PATH`. So the
install commands write the directories that hold `jev-router` and `node` into the service file, which is why
`command -v` must find both first. Run the install commands again after you reinstall jev-router under another
Node.js, for example with nvm.

Both templates log the same way:

- **The JSON log** goes to `~/.local/state/jev-router/router.log` and rotates to `router.log.1` at `logMaxBytes`
  (50 MiB by default). `jev-router report` and `jev-router ui` read it without an argument.
- **Messages for people**, such as startup errors and config reloads, go to
  `~/Library/Logs/jev-router/router.err.log` on macOS and to the journal on Linux.

### macOS launchd

The template is `examples/service/launchd/io.github.dirien.jev-router.plist`, a LaunchAgent with the label
`io.github.dirien.jev-router`. launchd also leaves `~` and `$HOME` unexpanded, so `sed` fills in your home directory
as well.

Install:

```bash
command -v jev-router node                   # both must print a path
mkdir -p ~/.config/jev-router ~/Library/Logs/jev-router ~/Library/LaunchAgents
touch ~/.config/jev-router/env && chmod 600 ~/.config/jev-router/env
# Put your keys in ~/.config/jev-router/env, one KEY=value per line: TYPESAFE_API_KEY, ...
plist="$(npm root -g)/@ediri/jev-router/examples/service/launchd/io.github.dirien.jev-router.plist"
path="$(dirname "$(command -v jev-router)"):$(dirname "$(command -v node)"):/usr/bin:/bin"
sed -e "s|@HOME@|$HOME|g" -e "s|@PATH@|$path|g" "$plist" > ~/Library/LaunchAgents/io.github.dirien.jev-router.plist
plutil -lint ~/Library/LaunchAgents/io.github.dirien.jev-router.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.dirien.jev-router.plist
```

Use:

```bash
launchctl print gui/$(id -u)/io.github.dirien.jev-router | head    # state and PID
launchctl kill HUP gui/$(id -u)/io.github.dirien.jev-router        # re-read the config
launchctl kickstart -k gui/$(id -u)/io.github.dirien.jev-router    # restart after an upgrade, or a change to the env file
tail -f ~/Library/Logs/jev-router/router.err.log                  # messages and startup errors
jev-router report                                                 # requests, spend and savings
```

The agent starts at login and restarts the router when it exits with an error, for example after a crash. It gives
the router 35 seconds to stop, room for the router's 30-second drain.

Uninstall:

```bash
launchctl bootout gui/$(id -u)/io.github.dirien.jev-router
rm ~/Library/LaunchAgents/io.github.dirien.jev-router.plist
```

### Linux systemd user unit

The template is `examples/service/systemd/jev-router.service`, a user unit named `jev-router`. systemd expands `%h`
to your home directory, so only `PATH` needs filling in.

Install:

```bash
command -v jev-router node                     # both must print a path
mkdir -p ~/.config/jev-router ~/.config/systemd/user
touch ~/.config/jev-router/env && chmod 600 ~/.config/jev-router/env
# Put your keys in ~/.config/jev-router/env, one KEY=value per line: TYPESAFE_API_KEY, OLLAMA_API_KEY, ...
unit="$(npm root -g)/@ediri/jev-router/examples/service/systemd/jev-router.service"
path="$(dirname "$(command -v jev-router)"):$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin"
sed "s|@PATH@|$path|" "$unit" > ~/.config/systemd/user/jev-router.service
systemctl --user daemon-reload
systemctl --user enable --now jev-router
loginctl enable-linger "$USER"                 # optional: keep it running while you're logged out
```

Use:

```bash
systemctl --user status jev-router
journalctl --user -u jev-router -f             # messages for people and startup errors
jev-router report                              # requests, spend and savings, from the JSON log
systemctl --user reload jev-router             # SIGHUP: re-read the config
systemctl --user restart jev-router            # after an upgrade, or a change to the env file
```

The unit restarts the router when it fails, and gives up after five failed starts within a minute, for example on a
broken config. It doesn't restart on exit status 9, which is Node's answer to an `--env-file` path that doesn't
exist: fix the path, then start the unit again.

Uninstall:

```bash
systemctl --user disable --now jev-router
rm ~/.config/systemd/user/jev-router.service
systemctl --user daemon-reload
```

### Docker Sandboxes

To run the router inside a Docker Sandbox instead, with the keys kept on the host and injected by the sandbox proxy,
follow [sandbox.md](sandbox.md).

## Verifying

1. **`jev-router doctor --env-file ~/.config/jev-router/env`** checks the config, the env file and its mode, the keys
   each target needs, the log file, Claude Code's settings, and whether a router answers.
   `jev-router doctor --live` also makes one real Jev call, which costs about $0.00003.
1. **In Claude Code**, `/status` shows `http://127.0.0.1:4000` as the API base URL.
1. **Health.** `curl -s http://127.0.0.1:4000/healthz` returns `"ok": true`, `jev.configured: true`, and one entry
   per Jev channel with its call and error counts.
1. **The live view**, at `http://127.0.0.1:4100` when the router runs with `--ui 4100`, shows each request as it
   arrives.
1. **The log.** Each request writes a `route` line with `tier`, `reason`, `model` and `upstream`, and, on a new
   human message, a `jev` object with the channel, probabilities and latency. `reason: "jev"` means Jev decided;
   `side-call`, `sticky` and `subagent` mean the request followed a rule without asking Jev.
1. **Response headers.** Claude Code doesn't show them, but any client can read `x-jev-tier`, `x-jev-model`,
   `x-jev-reason` and `x-jev-session`:

   ```bash
   curl -si http://127.0.0.1:4000/v1/messages \
     -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
     -d '{"model":"claude-sonnet-5","max_tokens":16,"messages":[{"role":"user","content":"Rename foo to bar in utils.ts"}]}' \
     | grep -iE '^(HTTP/|x-jev-)'
   ```

   This makes one Jev call and one small upstream request. `curl` has no Claude login to pass on, so without
   `ANTHROPIC_API_KEY` a request that lands on Anthropic returns 401; the `x-jev-*` headers still show the decision.

### A routing walkthrough

With real keys, this session exercises each routing rule. Start Claude Code through the router, then watch the
`reason` and `model` of each request in the live view or the log. The models are those of the default config.

| # | Do this | `reason`, model |
| --- | --- | --- |
| 1 | `What does git status -sb print? One sentence.` | `jev`, `glm-5.3-flash` |
| 2 | Same session: `Now list the files changed in the last commit.` | `jev-keep` (or `upgrade:jev` if Jev rates it harder) on the message, then `sticky` on every tool-loop step |
| 3 | Same session: `Find out why the tests in this project could be flaky and fix the cause.` | `upgrade:jev`, `claude-opus-5-5`, then `sticky` |
| 4 | Same session: `thanks!` | `jev-keep`: never back down mid-session |
| 5 | `/clear`, then `Use this key in deploy.sh:` followed by a made-up AWS-style key (`AKIA` plus 16 capital letters or digits) | `secrets: 1` and `trusted_only: true`, served by Anthropic whatever Jev says |
| 6 | `/model` with another model family than the current one, for example `/model sonnet` | `client-model:sonnet`, `claude-sonnet-5` |
| 7 | `/clear`, then `Tidy up the README #frontier` | `tag`, `claude-opus-5-5` |
| 8 | Background calls (automatic) | `side-call`, `claude-haiku-4-5` |

If Jev is less than 85% sure that a message is `fast` work, the router takes the more capable of Jev's top two tiers,
and the reason reads `jev-escalated`. Then run `jev-router report` for the requests, the spend per model, the savings
against Opus 5.5, and Jev's fallback rate and latency.

For Codex, run `jev-router launch codex` and try two sessions:

1. `Create cli.py with a parse_args function, then rename it to parse_cli_args.` This should go to Ollama Cloud, and
   the file edits must actually land. It's the riskiest path in this setup, and it hasn't been verified yet.
1. In a new session: `Design a caching layer for this router and justify the eviction policy.` This should go to
   `gpt-6-astra`. Check that model name against your OpenAI account.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Claude Code can't connect to the API | Nothing listens on the port in `ANTHROPIC_BASE_URL`. Start the router, or remove the settings. |
| `node: <path>: not found`, exit status 9 | The `--env-file` path doesn't exist. Check the path; a systemd unit doesn't restart on this. |
| A warning that other users can read or change the env file | Run the `chmod 600` the warning prints. |
| A warning that a variable in the env file has no effect | Proxy settings and `NODE_EXTRA_CA_CERTS` work only in the environment the router starts with: your shell, or the service file. |
| `reason: "no-jev"` in the log | No Jev channel has a key in the router's environment. Check the file with `jev-router doctor --env-file ~/.config/jev-router/env`, and make sure the router starts with that `--env-file`. |
| A changed key has no effect | The env file is read at startup, and `SIGHUP` reloads only the config. Restart the router. |
| `reason: "fallback:default"` or `"fallback:keep"` with a `jev.error` | Jev didn't answer. `/healthz` shows each channel's `lastError`. `HTTP 401` or `403` means a wrong key, and `HTTP 402` an OpenRouter account without credits. A failing channel is skipped for 30 seconds after a timeout and for 5 minutes after a 401, 402 or 403. |
| A warning that Claude Code requests carry no request class | `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` isn't set, or Claude Code is older than 2.1.273. Background calls can't be told apart reliably without it. |
| Claude Code compacts on every message | `ENABLE_TOOL_SEARCH=true` is missing. `jev-router doctor` says so when Claude Code points at the router. |
| The service doesn't answer on `/healthz` | Read `~/Library/Logs/jev-router/router.err.log` (macOS) or `journalctl --user -u jev-router` (Linux). A broken config stops the router at startup with every problem listed. |
| `cannot write the log file …` | The log file's directory is missing or not writable. The router keeps routing, and says when the file works again. |
| The live view answers 401 | It has a token. Open the address the router printed, which ends in `?token=`. |
| The live view answers 503 | More than 32 pages are open on it. Close some. |
| `403 Host "…" is not allowed` | The client used a host name other than `127.0.0.1`, `localhost` or `[::1]` with the router's port, for example through a published port. Add that `host:port` to `allowedHosts`. |
| `403 Cross-origin requests are not allowed` | The request carried an `Origin` header, as browsers do. Add the origin to `allowedOrigins` only if you mean to allow it. |
| `401 Missing or wrong x-jev-router-token header` | The router has a token. Send it through `ANTHROPIC_CUSTOM_HEADERS` (Claude Code) or `env_http_headers` (Codex). |
| The router exits with "Refusing to listen on … without a token" | A non-loopback host needs `JEV_ROUTER_TOKEN`. |
| The router exits with "Invalid router config" | Fix each problem it lists, then start it again. |
| A 502 that names a host and a cause, such as `getaddrinfo ENOTFOUND` | The router couldn't reach that upstream: DNS, the network or TLS. The `error` line in the log has the same text. |
| 401 from Ollama Cloud | `OLLAMA_API_KEY` is missing or wrong. Ollama Cloud only accepts a bearer key. |
| 400 from Anthropic about `thinking`, `effort` or `context_management` on Haiku | That target has no `omit` list. Compare it with `surfaces.anthropic.side` in the packaged config. |
| Codex warns about an unknown model or uses the wrong tools | `model_catalog_json` isn't the absolute path to `jev-models.json`. |
| A session stays on `frontier` | That's the ratchet: mid-session the tier only moves up. `/clear` starts a new session, and a session idle for `policy.idleResetMinutes` (10 by default) is decided afresh. |

## Turning it off

- **`launch`:** nothing to undo. Plain `claude` and `codex` don't go through the router.
- **Shell variables:** open a new shell, or run the `unset` line from
  [Environment for the current shell](#environment-for-the-current-shell).
- **`settings.json`:** delete the keys from the `env` block (see
  [Persistent settings.json](#persistent-settingsjson)) and restart Claude Code.
- **Codex profile:** `rm ~/.codex/jev.config.toml`. Codex without `--profile jev` uses your default settings.
- **launchd:** run the uninstall commands in [macOS launchd](#macos-launchd).
- **systemd:** run the uninstall commands in [Linux systemd user unit](#linux-systemd-user-unit).
- **Docker Sandboxes:** see the teardown in [sandbox.md](sandbox.md#teardown).
- **Everything:** after the above, `npm uninstall -g @ediri/jev-router`, then
  `rm -rf ~/.local/state/jev-router ~/.config/jev-router`, which also deletes your env file.
