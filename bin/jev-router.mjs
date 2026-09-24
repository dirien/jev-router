#!/usr/bin/env node
// The `jev-router` command. A failure prints one short message and exits 1: a stack trace helps
// nobody who mistyped a flag or has a broken config.
import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).then(
  (code) => {
    if (typeof code === 'number') process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`jev-router: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
