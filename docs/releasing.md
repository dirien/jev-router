# Releasing jev-router

A release is a `vX.Y.Z` tag on `main`. Pushing the tag runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml): it checks and packs the package, publishes the
Docker Sandboxes kit, creates the GitHub Release, and publishes to npm once that's turned on.

## Cut a release

1. Set the new version in `package.json` and in `VERSION` in `src/router.mjs`, then run
   `npm install --package-lock-only` so `package-lock.json` matches.
1. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add an empty `## [Unreleased]` above
   it, and update the compare links at the bottom. That section becomes the release notes, so write it for users.
1. Commit as `chore(release): X.Y.Z` and check the result. The git install in the smoke test uses the last commit,
   so run it after committing:

   ```bash
   npm run check
   npm run test:package -- --git
   ```

1. Merge to `main`, then tag the merged commit and push the tag:

   ```bash
   git switch main && git pull
   git tag -a vX.Y.Z -m vX.Y.Z
   git push origin vX.Y.Z
   ```

A tag with a pre-release suffix, such as `v1.5.0-rc.1`, needs the same version in `package.json` and its own
changelog section. It becomes a GitHub pre-release, leaves the kit's `latest` tag alone, and goes to npm under the
`next` tag. `#semver:^1` installs never pick it up.

## What the workflow does

The jobs run in this order, and each one waits for the one before, so a failed check publishes nothing.

| Job | Permissions | What it does |
| --- | --- | --- |
| check and pack | `contents: read` | Fails unless the tag is `v` plus the version in `package.json`. Packs the tarball before `npm ci`, so no dependency's code has run when it's made, and takes the notes from `CHANGELOG.md`: no section, no release. Runs the package smoke test on that tarball and on a git install, then `npm ci` and `npm run check`, and writes `SHA256SUMS` |
| sandbox kit | `contents: read`, `packages: write` | Installs sbx, pinned and checked against its SHA-256, writes the version into `sbx/jev-router-kit/spec.yaml`, runs `sbx kit validate`, and pushes `ghcr.io/dirien/jev-router-kit:X.Y.Z`, plus `latest` for the newest release |
| GitHub release | `contents: write` | Creates the release with the notes, the tarball and `SHA256SUMS`. When npm publishing is off, it adds a notice to the run that says so |
| npm publish | `id-token: write` | Runs only when the repository variable `NPM_PUBLISH` is `true`. Checks the tarball against `SHA256SUMS`, then publishes that file with provenance through npm trusted publishing. With an `NPM_TOKEN` secret, npm falls back to the token when trusted publishing fails, which covers a package's first publish |

The package smoke test, `scripts/smoke-package.mjs`, installs the package the way users do, with
`npm install -g --prefix` into a temporary directory. Under a temporary `HOME`, with no proxy variables and no keys
in the environment, it runs `jev-router version`, `init --anthropic-only` and `serve` with its live view and an env
file, then checks `/healthz`, the view's page and event stream, `env claude`, `launch claude` with a stand-in agent,
and that `SIGTERM` stops the router cleanly. Last, it runs `setup --yes --service none` against a local Jev stand-in,
and `uninstall`. CI runs it on Node.js 22 and 24.

## What a release gives users

| Install | Command |
| --- | --- |
| The newest 1.x from GitHub | `npm install -g github:dirien/jev-router#semver:^1` |
| One version from GitHub | `npm install -g github:dirien/jev-router#vX.Y.Z` |
| The release tarball | `npm install -g ./ediri-jev-router-X.Y.Z.tgz`, after `gh release download vX.Y.Z -R dirien/jev-router` and `sha256sum -c SHA256SUMS` |
| npm | `npx @ediri/jev-router setup`, or `npm install -g @ediri/jev-router` |
| The Docker Sandboxes kit | `sbx create --kit ghcr.io/dirien/jev-router-kit:X.Y.Z claude <workspace>` |

Installing again with the same command updates jev-router; `npm uninstall -g @ediri/jev-router` removes it. The
GitHub installs need git, and nothing else: the repository is public.

## The kit on GHCR

The first push created the package `ghcr.io/dirien/jev-router-kit` as a private package, and it has since been made
public, so sbx pulls it without a login. It holds only the kit's `spec.yaml`, which names hosts and key variables but
no keys.

In a fork, the first push creates a private package too. To make it public, open the package on GitHub, then
**Package settings** and **Change visibility**.

sbx allows only `docker.io/` kits by default, so users allow the source once:

```bash
sbx settings set kit.allowedSources '["docker.io/","ghcr.io/dirien/","github.com/dirien/"]'
```

sbx can also read the kit from git, without the registry:
`--kit "git+https://github.com/dirien/jev-router.git#ref=vX.Y.Z&dir=sbx/jev-router-kit"`.

To move the workflow to a newer sbx, change `SBX_VERSION` and `SBX_SHA256` in `release.yml`. The comment above them
has the command that prints the digest. Dependabot doesn't update these two.

## Turn on npm publishing

npm publishing is on for `@ediri/jev-router`: the repository variable `NPM_PUBLISH` is `true`, and each release goes
to npm with provenance through npm trusted publishing, with no token.

The first publish needs a token, because trusted publishing can't create a package: npm adds a trusted publisher only
to a package that exists ([npm/cli#8544](https://github.com/npm/cli/issues/8544)). That's how 1.5.0 went out, and
how a fork starts. The repository has to be public, since npm doesn't generate provenance for a private one.

1. On npmjs.com, create a granular access token with read and write access to all packages (a package that doesn't
   exist can't be selected), with two-factor authentication bypassed, because CI can't type a code, and with a short
   expiration, such as 7 days.
1. Store it as the repository secret `NPM_TOKEN`, and turn the job on:

   ```bash
   gh secret set NPM_TOKEN -R dirien/jev-router          # paste the token at the prompt
   gh variable set NPM_PUBLISH --body true -R dirien/jev-router
   ```

1. Cut the release. The npm job tries trusted publishing first. For a package that isn't on npm yet that fails, and
   npm falls back to the token. While the secret exists, every run warns about it.
1. Add the trusted publisher. On npmjs.com, open the package's **Settings** and choose GitHub Actions with the owner
   `dirien`, the repository `jev-router` and the workflow `release.yml`, and no environment. Or, with npm 11.15 or
   newer and two-factor authentication on the account:

   ```bash
   npm trust github @ediri/jev-router --repo dirien/jev-router --file release.yml --allow-publish
   ```

1. Delete the token: `gh secret delete NPM_TOKEN -R dirien/jev-router`, then revoke it on npmjs.com.
1. Optionally, in the package's settings, require two-factor authentication and disallow tokens, so only the
   workflow can publish.

Keep `repository.url` in `package.json` pointing at `github.com/dirien/jev-router`: npm checks it against the
provenance.

## When a release fails

- **Nothing was published yet**, because the check and pack job or the kit's validation failed: fix the problem on
  `main`, then move the tag and push it again.

  ```bash
  git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z
  git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z
  ```

- **A publish job failed**: re-run the failed jobs from the workflow run's page. Pushing the kit again replaces its
  tags, and the GitHub release job removes its draft when an upload fails.
- **npm has a bad version**: npm never accepts the same version twice, so release the next patch version.
