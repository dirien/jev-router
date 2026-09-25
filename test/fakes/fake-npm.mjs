#!/usr/bin/env node
// Stands in for `npm` in test/cli.test.mjs, so `jev-router setup` can install itself globally
// without the network or the real npm. It records every call; `install -g` links jev-router into
// a fake global prefix, and `prefix -g` prints that prefix. Its settings come from the environment:
//   FAKE_NPM_LOG     JSON lines file to append each call's arguments to (required)
//   FAKE_NPM_PREFIX  the global prefix: `install -g` links <prefix>/bin/jev-router
//   FAKE_NPM_LINK    what that link points at: a jev-router outside npx's cache
//   FAKE_NPM_FAIL    an npm error code, such as EACCES or EEXIST, for `install -g` to fail with
import { appendFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const { FAKE_NPM_LOG: log, FAKE_NPM_PREFIX: prefix = '', FAKE_NPM_LINK: link = '', FAKE_NPM_FAIL: fail } = process.env;
if (!log) throw new Error('FAKE_NPM_LOG is not set');
appendFileSync(log, `${JSON.stringify(args)}\n`);

if (args[0] === 'prefix') {
  process.stdout.write(`${prefix}\n`);
} else if (args[0] === 'install' && (args.includes('-g') || args.includes('--global'))) {
  if (fail) {
    process.stderr.write(`npm error code ${fail}\nnpm error the fake npm was told to fail\n`);
    process.exitCode = 1;
  } else {
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    rmSync(join(prefix, 'bin', 'jev-router'), { force: true });
    symlinkSync(link, join(prefix, 'bin', 'jev-router'));
    process.stdout.write('\nadded 1 package in 1s\n');
  }
}
