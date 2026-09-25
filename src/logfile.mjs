// The router's log file: one JSON line per entry, appended with mode 0600. A file that would grow
// past its size limit is renamed to <file>.1 first, replacing the one before, so a router that runs
// for months keeps two files of log at most.

import { appendFileSync, lstatSync, renameSync } from 'node:fs';

/**
 * Appends one line to a log file. When `maxBytes` is above 0 and the line would take a non-empty
 * regular file past it, the file becomes `<file>.1` first, and the previous `<file>.1` goes. A
 * rotation that fails leaves the line in the old file rather than lose it.
 * @param {string} file
 * @param {string} line
 * @param {number} maxBytes 0 turns rotation off
 * @returns {boolean} whether the file was rotated
 * @throws {Error} when the line can't be written
 */
export function appendLogLine(file, line, maxBytes) {
  const rotated = maxBytes > 0 && rotate(file, Buffer.byteLength(line), maxBytes);
  appendFileSync(file, line, { mode: 0o600 });
  return rotated;
}

/**
 * Renames the file to `<file>.1` when `adding` more bytes would take it past `maxBytes`. Only a
 * regular file rotates: renaming a symbolic link would move the link and leave its target growing.
 * @param {string} file
 * @param {number} adding
 * @param {number} maxBytes
 * @returns {boolean} whether it was renamed
 */
function rotate(file, adding, maxBytes) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size === 0 || info.size + adding <= maxBytes) return false;
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false; // no file yet, or one that can't be renamed: the line goes to the file as it is
  }
}
