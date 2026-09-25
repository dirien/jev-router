# Contributing

jev-router is small on purpose: plain Node.js ESM, no runtime dependencies, no build step. Contributions that keep
it that way are welcome.

## Setup

You need Node.js 22 or newer, and a clone of the repository. Using jev-router doesn't need a clone; working on it
does.

```bash
git clone https://github.com/dirien/jev-router.git
cd jev-router
npm ci
npm run check
```

`npm run check` runs Biome, the TypeScript check, markdownlint, and the tests with coverage thresholds. CI runs the
same on Node.js 22 and 24, so a green `npm run check` locally is the bar for a pull request.

`npm run test:package` installs the packed package into a temporary directory, the way users install it, and runs
the installed command with an env file and no network. CI runs it with `--git` too, which also installs the last
commit from git. Run it when you change what the package ships: `files` or `bin` in `package.json`, `examples/`,
`config/`, `ui/` or `sbx/`.

## Making a change

- Open an issue first for anything bigger than a fix, especially new routing rules, config keys or dependencies.
- Keep runtime dependencies at zero.
- Keep jev-router working on a plain Mac or Linux machine. Docker Sandboxes are an option, never a requirement:
  don't make the router depend on a sandbox's variables.
- Add or update tests. The integration tests run the router against mock upstreams and a mock Jev and assert the
  calls each test made (`delta()` in `test/router.test.mjs`). Build fake credentials at runtime (`fake(...)`), so no
  test file contains something that looks like a real key.
- If you change the Jev question, the options or what Jev sees, run `npm run eval` with a Jev key and paste the
  summary into the pull request. [docs/evaluation.md](docs/evaluation.md) explains the numbers.
- Update `README.md` and `docs/` when behavior or configuration changes, and add a line under `Unreleased` in
  [CHANGELOG.md](CHANGELOG.md). The README's instructions for users must work without a clone.
- Never commit secrets, `.env` files, router logs, eval results or scratch files.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages and pull request titles:
  `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `ci:`, `chore:`.
- Keep one logical change per pull request. The pull request template has the checklist.
- [AGENTS.md](AGENTS.md) lists the conventions for coding agents. They apply to people too.

## Releases

The maintainer cuts releases with a version tag. [docs/releasing.md](docs/releasing.md) has the steps and what the
release workflow publishes.

## Security issues

Don't open a public issue. Follow [SECURITY.md](SECURITY.md).

## License

Contributions are licensed under Apache-2.0, like the rest of the project ([LICENSE](LICENSE)).
