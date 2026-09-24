# Security policy

jev-router runs on your machine, holds API keys, and sees your prompts on their way to the model providers. Reports
about any way around the boundaries below are welcome.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x | Yes |

## Reporting a vulnerability

Report vulnerabilities privately, never in a public issue, pull request or discussion.

- **Email** [info@ediri.de](mailto:info@ediri.de) with "jev-router security" in the subject. This works now, while
  the repository is private.
- **GitHub**, once the repository is public: use
  [private vulnerability reporting](https://github.com/dirien/jev-router/security/advisories/new)
  (**Security**, then **Report a vulnerability**).

Include the version (`jev-router version`), the config with keys removed, the steps to reproduce, and what an
attacker gains. Don't send real API keys, or prompts that contain secrets.

The maintainer acknowledges the report, works on a fix, and publishes it with a changelog entry and, once the
repository is public, a GitHub security advisory that credits you unless you'd rather not be named. Please allow
time for the fix before you disclose the issue publicly.

## Scope

### Loopback binding

- The router listens on `127.0.0.1:4000` by default, and refuses to listen on a non-loopback address unless
  `JEV_ROUTER_TOKEN` is set.
- It refuses a `Host` header other than `127.0.0.1`, `localhost` or `[::1]` on its port, which blocks DNS
  rebinding, and any request with an `Origin` header, which blocks cross-site requests from a browser tab. Both can
  be widened with `allowedHosts` and `allowedOrigins`.
- With a token, every proxied request must carry it as `x-jev-router-token`, compared in constant time.
  `GET /healthz` answers without the token and returns only counters and channel health, no keys and no prompts.
- It serves the proxied `/v1/*` routes and `/healthz` only. There is no admin API.

### Secret handling

- Upstream and Jev keys come from environment variables. Each key goes only to the host of the target or Jev channel
  that names it, and upstream redirects are refused, so a key can't follow one.
- The client's own credential, such as a Claude login, is forwarded only to targets marked `clientAuth`
  (Anthropic in the packaged configs).
- A deterministic scanner checks every human message. A hit keeps the session on the `trusted` target, and pins,
  tags and Jev's answer can't override that.
- Untrusted targets get secrets redacted anywhere in the body, tool output included, a minimal set of headers, and
  no `metadata`.
- Jev's state is scrubbed before it's truncated, and it never includes tool output, file contents or the system
  prompt.

### What the router stores

- **The state file**, `~/.local/state/jev-router/sessions.jsonl` by default, with mode 0600 in a directory with
  mode 0700. It holds SHA-256 hashes of session IDs, tiers, trust flags, turn counts, the client's model name, the
  last upstream host, and a hash of the message where the provider changed. It holds no prompt text. Entries expire
  after seven days.
- **The logs**, on stdout and in `logFile` when it's set (mode 0600). `jev-router launch` writes its router's log to
  `~/.local/state/jev-router/router.log`. They hold routing decisions, Jev's probabilities, token usage and cost,
  and no prompt text or keys.

The router writes nothing else to disk. Of the other commands, only `jev-router init` (the config file) and
`jev-router launch codex` (the Codex profile, `~/.codex/jev.config.toml`) write files.

### Out of scope

- A credential format the secret scanner doesn't know. The scanner is a documented best effort; new patterns are
  welcome as ordinary issues or pull requests.
- Attacks that need code running as your user, which can read the router's environment and keys anyway.
- Access you widened on purpose, through `allowedHosts`, `allowedOrigins` or a non-loopback address.
- Vulnerabilities in Claude Code, the Codex CLI, the model providers, TypeSafe, OpenRouter or Docker Sandboxes.
  Report those to their vendors.
- What the model providers and the Jev channel do with the data they receive. See their terms.
