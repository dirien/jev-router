// Per-conversation routing state. It survives restarts through an append-only JSONL file, so a
// config reload or crash doesn't move live sessions to another model mid-task. Keys are stored
// hashed; the file holds tiers and hosts, never prompt text.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** @import { SessionEntry } from './types.js' */

/**
 * @typedef {object} SessionStoreOptions
 * @property {string | null} [file] the JSONL state file; without one, sessions live in memory only
 * @property {number} [max] most sessions kept; the least recently used go first
 * @property {number} [ttlMs] loading the file drops sessions not updated for this long
 * @property {(err: unknown) => void} [onError] receives file errors, so that they never stop routing
 */

/**
 * The stored form of a session key, so the state file never holds a client's session id.
 * @param {string} key
 * @returns {string}
 */
export const hashKey = (key) => createHash('sha256').update(String(key)).digest('hex').slice(0, 32);

/** Session entries by key, least recently used first. */
export class SessionStore {
  /** @param {SessionStoreOptions} [options] */
  constructor({ file = null, max = 10000, ttlMs = 7 * 24 * 3600 * 1000, onError = () => undefined } = {}) {
    this.file = file;
    this.max = max;
    this.ttlMs = ttlMs;
    this.onError = onError;
    /** @type {Map<string, SessionEntry>} */
    this.map = new Map();
    if (file) this.#load(file);
  }

  get size() {
    return this.map.size;
  }

  /**
   * A session's entry. Reading it makes the session the most recently used.
   * @param {string} key
   * @returns {SessionEntry | undefined}
   */
  get(key) {
    const k = hashKey(key);
    const entry = this.map.get(k);
    if (!entry) return undefined;
    this.map.delete(k); // most recently used last
    this.map.set(k, entry);
    return entry;
  }

  /**
   * Stores a session's entry, stamped with the time, and appends it to the file.
   * @param {string} key
   * @param {SessionEntry} entry
   * @returns {SessionEntry} the stored entry
   */
  set(key, entry) {
    const k = hashKey(key);
    const value = { ...entry, updated: Date.now() };
    this.map.delete(k);
    this.map.set(k, value);
    this.#trim();
    if (this.file) {
      const { lastSeen, ...persisted } = value;
      try {
        appendFileSync(this.file, `${JSON.stringify({ k, ...persisted })}\n`, { mode: 0o600 });
      } catch (err) {
        this.onError(err);
      }
    }
    return value;
  }

  /**
   * Marks activity without writing to disk.
   * @param {string} key
   */
  touch(key) {
    const entry = this.map.get(hashKey(key));
    if (entry) entry.lastSeen = Date.now();
  }

  // Drops the least recently used sessions beyond `max`.
  #trim() {
    for (const k of this.map.keys()) {
      if (this.map.size <= this.max) break;
      this.map.delete(k);
    }
  }

  /** @param {string} file */
  #load(file) {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      if (!existsSync(file)) return;
      const now = Date.now();
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          /** @type {{ k: string } & SessionEntry} */
          const { k, ...entry } = JSON.parse(line);
          this.map.delete(k);
          if (now - (entry.updated ?? 0) < this.ttlMs) this.map.set(k, { ...entry, lastSeen: entry.updated });
        } catch {
          /* a torn last line after a crash */
        }
      }
      this.#trim();
      // Rewrite one line per live session so the file doesn't grow forever.
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, [...this.map].map(([k, { lastSeen, ...e }]) => `${JSON.stringify({ k, ...e })}\n`).join(''), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      this.onError(err);
    }
  }
}
