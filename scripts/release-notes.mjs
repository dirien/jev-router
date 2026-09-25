#!/usr/bin/env node
// Prints the notes for one release: that version's section of CHANGELOG.md, without its heading,
// plus the compare link the changelog defines for it, if any. The release workflow uses it for the
// GitHub Release. It exits 1 when the section is missing or empty, so a release can't go out without
// notes.
//
//   node scripts/release-notes.mjs 1.4.0 > notes.md
import { readFileSync } from 'node:fs';

const [version, ...extra] = process.argv.slice(2);
if (!version || extra.length) {
  console.error('Usage: node scripts/release-notes.mjs <version>');
  process.exit(2);
}

const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/\r?\n/);
const heading = `## [${version}]`;
const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} `));
// The section ends at the next heading of its level, or at the link definitions after the last one.
const rest = start === -1 ? [] : lines.slice(start + 1);
const end = rest.findIndex((line) => line.startsWith('## ') || /^\[[^\]]+\]: /.test(line));
const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
if (!body) {
  console.error(`CHANGELOG.md has no notes under "${heading}". Add them before tagging v${version}.`);
  process.exit(1);
}
const link = lines.find((line) => line.startsWith(`[${version}]: `))?.slice(version.length + 4);
process.stdout.write(link?.includes('/compare/') ? `${body}\n\n**Full diff:** ${link}\n` : `${body}\n`);
