# Activating jev-router

This guide connects Claude Code and the Codex CLI to jev-router, keeps the router running as a service, and shows
how to check that routing works and how to turn it off again. The examples use the default address,
`http://127.0.0.1:4000`. [configuration.md](configuration.md) covers the config itself.

All three Claude Code setups set the same variables:

| Variable | Value | Why |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:4000` | Sends Claude Code's API traffic to the router instead of Anthropic |
| `CLAUDE_CODE_GATEWAY_HINT_HEADERS` | `1` | Labels each request as main loop, subagent, compaction, workflow or background work (Claude Code 2.1.273 and later), so only a person's messages decide the tier |
| `ENABLE_TOOL_SEARCH` | `true` | Claude Code turns MCP tool search off when `ANTHROPIC_BASE_URL` isn't Anthropic's, and then sends every MCP tool's definition with every request. With a few MCP servers that fills most of the context window, and Claude Code compacts on every message. The router forwards tool search as is |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `160000` | Claude Code can't learn the routed model's context window through a gateway. 160,000 tokens compacts before the smallest window among the tiers |
| `ANTHROPIC_CUSTOM_HEADERS` | `x-jev-router-token: <token>` | Only when the router has a token (`JEV_ROUTER_TOKEN`) |

None of them is an API key. Claude Code keeps using your Claude login, and the router passes that credential to
Anthropic and to no other host. Requests that the router sends to Ollama Cloud or OpenAI use the router's own keys.

## Claude Code

### One-shot launch

```bash
jev-router launch claude                   # router on 127.0.0.1:4000
jev-router launch claude --port 4100       # another port
jev-router launch claude -- --continue     # arguments after -- go to claude
```

`launch claude` reuses a router that already answers on the port. If none does, it starts one inside its own
process, which logs to `~/.local/state/jev-router/router.log`. Then it runs `claude` with the variables above and
exits with Claude Code's exit code. Set `JEV_ROUTER_CLAUDE_BIN` to run a specific `claude` binary.

A router that `launch` started lives only as long as that `launch` process. If you run several Claude Code sessions
at once, start the router separately (`jev-router serve`, or a [service](#running-the-router-as-a-service)), so
that closing the first session doesn't take the router away from the others.

### Environment for the current shell

With the router already running in another terminal or as a service, load the variables into your shell and start
Claude Code as usual:

```bash
jev-router serve                        # terminal 1, unless it runs as a service
eval "$(jev-router env claude)"         # terminal 2
claude
```

`jev-router env claude` prints `export` lines for the variables in the table. Pass the same `--port` or `--config`
as the router uses, so the address and the token match. Every `claude` you start from that shell then goes through
the router. To stop, open a new shell or unset the variables:

```bash
unset ANTHROPIC_BASE_URL CLAUDE_CODE_GATEWAY_HINT_HEADERS CLAUDE_CODE_AUTO_COMPACT_WINDOW ENABLE_TOOL_SEARCH ANTHROPIC_CUSTOM_HEADERS
```

[`examples/claude-code.env`](../examples/claude-code.env) holds the same settings as a file you can `source`, plus a
cap on output tokens and commented-out lines for a token or a tier pin.

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
error, so [run the router as a service](#running-the-router-as-a-service). A value in `settings.json` wins over the
same variable in your shell ([Claude Code docs](https://code.claude.com/docs/en/llm-gateway-connect)), so `unset`
doesn't bypass it.

To undo it, delete those keys from the `env` block and restart Claude Code. With `jq`:

```bash
jq 'del(.env.ANTHROPIC_BASE_URL, .env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, .env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, .env.ENABLE_TOOL_SEARCH,
  .env.ANTHROPIC_CUSTOM_HEADERS)' ~/.claude/settings.json > ~/.claude/settings.json.new \
  && mv ~/.claude/settings.json.new ~/.claude/settings.json
```

## Codex CLI

### Codex launch

```bash
jev-router launch codex             # writes or refreshes ~/.codex/jev.config.toml, then runs codex --profile jev
jev-router launch codex --force     # rewrites the profile first
```

`launch codex` writes the `jev` profile to `~/.codex/jev.config.toml`. A profile it wrote and nobody edited is
refreshed whenever the router's port or token changes; a profile you edited is kept, with a note, and `--force`
replaces it. Arguments after `--` go to `codex`, and `JEV_ROUTER_CODEX_BIN` runs a specific binary. Profile files need
Codex 0.134.0 or newer.

### Codex profile by hand

The profile is [`examples/codex/jev.config.toml`](../examples/codex/jev.config.toml):

1. Copy it to `~/.codex/jev.config.toml`.
1. Set `model_catalog_json` to the absolute path of
   [`examples/codex/jev-models.json`](../examples/codex/jev-models.json).
1. Run `codex --profile jev`.

For a global npm install, this does the first two steps:

```bash
examples="$(npm root -g)/jev-router/examples/codex"
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

## Running the router as a service

A service keeps one router running for all your clients, independent of any terminal, and restarts it if it crashes.
Session state persists in `~/.local/state/jev-router/sessions.jsonl`, so a restart doesn't move live sessions to
another model.

The `jev-router` command starts with `#!/usr/bin/env node`, so the service needs `node` on its `PATH`. Neither
launchd nor systemd reads your shell profile, and launchd doesn't expand `~` or variables. Find the absolute paths
first:

```bash
command -v jev-router
command -v node
```

### macOS launchd

Keep the keys in your login keychain, not in the plist. Store each one once; `-w` at the end makes `security` prompt
for the value, so it doesn't land in your shell history:

```bash
security add-generic-password -a "$USER" -s jev-router.typesafe -w
security add-generic-password -a "$USER" -s jev-router.ollama -w
security add-generic-password -a "$USER" -s jev-router.openai -w       # optional
security add-generic-password -a "$USER" -s jev-router.openrouter -w   # optional
```

Create `~/.config/jev-router/with-keys.sh`, a small wrapper that reads the keys and then runs the command it's given:

```sh
#!/bin/sh
# Reads jev-router's upstream keys from the login keychain, then runs the given command.
set -eu
load() {
  if value=$(security find-generic-password -s "$2" -w 2>/dev/null); then
    export "$1=$value"
  fi
}
load TYPESAFE_API_KEY jev-router.typesafe
load OPENROUTER_API_KEY jev-router.openrouter
load OLLAMA_API_KEY jev-router.ollama
load OPENAI_API_KEY jev-router.openai
exec "$@"
```

```bash
chmod 700 ~/.config/jev-router/with-keys.sh
~/.config/jev-router/with-keys.sh jev-router doctor   # checks the setup with the keychain keys loaded
```

If macOS asks whether `security` may use the item, choose **Always Allow**.

Create `~/Library/LaunchAgents/dev.dirien.jev-router.plist`. Replace `/Users/you` with your home directory, and the
`jev-router` and `PATH` entries with the paths from `command -v` above:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.dirien.jev-router</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.config/jev-router/with-keys.sh</string>
    <string>/opt/homebrew/bin/jev-router</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/jev-router.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/jev-router.log</string>
</dict>
</plist>
```

The plist holds paths only. The keys exist only in the keychain and in the router's process environment.

```bash
plist=~/Library/LaunchAgents/dev.dirien.jev-router.plist
plutil -lint "$plist"
launchctl bootstrap gui/"$(id -u)" "$plist"                  # start now and at every login
launchctl print gui/"$(id -u)"/dev.dirien.jev-router | head   # state and PID
launchctl kill HUP gui/"$(id -u)"/dev.dirien.jev-router       # reload the config
launchctl kickstart -k gui/"$(id -u)"/dev.dirien.jev-router   # restart, for example after an upgrade
jev-router report ~/Library/Logs/jev-router.log              # usage and savings so far
```

With `KeepAlive`, launchd restarts the router whenever it exits, including when a broken config stops it at
startup, so check `~/Library/Logs/jev-router.log` if `/healthz` doesn't answer. The log grows without bound; rotate
or truncate it from time to time.

### Linux systemd user unit

Keep the keys in an environment file that only you can read:

```bash
install -d -m 700 ~/.config/jev-router
install -m 600 /dev/null ~/.config/jev-router/env
"${EDITOR:-vi}" ~/.config/jev-router/env
```

```text
TYPESAFE_API_KEY=...
OLLAMA_API_KEY=...
OPENAI_API_KEY=...
```

Create `~/.config/systemd/user/jev-router.service`, with the paths from `command -v` above:

```ini
[Unit]
Description=jev-router, a Jev model router for Claude Code and Codex

[Service]
EnvironmentFile=%h/.config/jev-router/env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/jev-router serve
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now jev-router
systemctl --user status jev-router
journalctl --user -u jev-router -f          # the log
systemctl --user reload jev-router          # SIGHUP: re-read the config
loginctl enable-linger "$USER"              # optional: keep it running while you're logged out
```

The log goes to the journal. For `jev-router report`, set `logFile` in the config, or export the journal first:

```bash
journalctl --user -u jev-router -o cat > router.jsonl && jev-router report router.jsonl
```

### Docker Sandboxes

To run Claude Code, Codex and the router inside a Docker Sandbox, with the keys kept in your host keychain and
injected by the sandbox proxy, follow [sandbox.md](sandbox.md).

## Verifying

1. **In Claude Code**, `/status` shows `http://127.0.0.1:4000` as the API base URL.
1. **`jev-router doctor`** checks the setup. `jev-router doctor --live` also makes one real Jev call, which costs
   about $0.00003.
1. **Health.** `curl -s http://127.0.0.1:4000/healthz` returns `"ok": true`, `jev.configured: true`, and one entry
   per Jev channel with its call and error counts.
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

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Claude Code can't connect to the API | Nothing listens on the port in `ANTHROPIC_BASE_URL`. Start the router, or remove the settings. |
| `reason: "no-jev"` in the log | No Jev channel has a key in the router's environment. Set `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`; for a service, check the keychain wrapper or the environment file. |
| `reason: "fallback:default"` or `"fallback:keep"` with a `jev.error` | Jev didn't answer. `/healthz` shows each channel's `lastError`. `HTTP 401` or `403` means a wrong key, and `HTTP 402` an OpenRouter account without credits. A failing channel is skipped for 30 seconds after a timeout and for 5 minutes after a 401, 402 or 403. |
| A warning that Claude Code requests carry no request class | `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` isn't set, or Claude Code is older than 2.1.273. Background calls can't be told apart reliably without it. |
| `403 Host "…" is not allowed` | The client used a host name other than `127.0.0.1`, `localhost` or `[::1]` with the router's port, for example through a published port. Add that `host:port` to `allowedHosts`. |
| `403 Cross-origin requests are not allowed` | The request carried an `Origin` header, as browsers do. Add the origin to `allowedOrigins` only if you mean to allow it. |
| `401 Missing or wrong x-jev-router-token header` | The router has a token. Send it through `ANTHROPIC_CUSTOM_HEADERS` (Claude Code) or `env_http_headers` (Codex). |
| The router exits with "Refusing to listen on … without a token" | A non-loopback host needs `JEV_ROUTER_TOKEN`. |
| The router exits with "Invalid router config" | Fix each problem it lists, then start it again. |
| 401 from Ollama Cloud | `OLLAMA_API_KEY` is missing or wrong. Ollama Cloud only accepts a bearer key. |
| 400 from Anthropic about `thinking`, `effort` or `context_management` on Haiku | That target has no `omit` list. Compare it with `surfaces.anthropic.side` in the packaged config. |
| Codex warns about an unknown model or uses the wrong tools | `model_catalog_json` isn't the absolute path to `jev-models.json`. |
| A session stays on `frontier` | That's the ratchet: mid-session the tier only moves up. `/clear` starts a new session, and a session idle for `policy.idleResetMinutes` (10 by default) is decided afresh. |

## Turning it off

- **`launch`:** nothing to undo. Plain `claude` and `codex` don't go through the router.
- **Shell variables:** open a new shell, or run the `unset` line from [Environment for the current
  shell](#environment-for-the-current-shell).
- **`settings.json`:** delete the keys from the `env` block (see
  [Persistent settings.json](#persistent-settingsjson)) and restart Claude Code.
- **Codex profile:** `rm ~/.codex/jev.config.toml`. Codex without `--profile jev` uses your default settings.
- **launchd:** `launchctl bootout gui/"$(id -u)"/dev.dirien.jev-router`, then delete the plist. Remove the keychain
  items with `security delete-generic-password -s jev-router.typesafe` (and the other service names).
- **systemd:** `systemctl --user disable --now jev-router`, then delete the unit and `~/.config/jev-router/env`.
- **Docker Sandboxes:** see the teardown in [sandbox.md](sandbox.md#teardown).
- **Everything:** `npm uninstall -g jev-router`, then `rm -rf ~/.local/state/jev-router ~/.config/jev-router`.
