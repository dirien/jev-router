// Per-conversation routing state. It survives restarts through an append-only JSONL file, so a
// config reload or crash doesn't move live sessions to another model mid-task. Keys are stored
// hashed; the file holds tiers and hosts, never prompt text.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const hashKey = (key) => createHash('sha256').update(String(key)).digest('hex').slice(0, 32);

export class SessionStore {
  constructor({ file = null, max = 10000, ttlMs = 7 * 24 * 3600 * 1000, onError = () => {} } = {}) {
    this.file = file;
    this.max = max;
    this.ttlMs = ttlMs;
    this.onError = onError;
    this.map = new Map();
    if (file) this.#load();
  }

  get size() { return this.map.size; }

  get(key) {
    const k = hashKey(key);
    const entry = this.map.get(k);
    if (!entry) return undefined;
    this.map.delete(k); // most recently used last
    this.map.set(k, entry);
    return entry;
  }

  set(key, entry) {
    const k = hashKey(key);
    const value = { ...entry, updated: Date.now() };
    this.map.delete(k);
    this.map.set(k, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    if (this.file) {
      const { lastSeen, ...persisted } = value;
      try { appendFileSync(this.file, `${JSON.stringify({ k, ...persisted })}\n`, { mode: 0o600 }); } catch (err) { this.onError(err); }
    }
    return value;
  }

  // Marks activity without writing to disk.
  touch(key) {
    const entry = this.map.get(hashKey(key));
    if (entry) entry.lastSeen = Date.now();
  }

  #load() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      if (!existsSync(this.file)) return;
      const now = Date.now();
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const { k, ...entry } = JSON.parse(line);
          this.map.delete(k);
          if (now - (entry.updated ?? 0) < this.ttlMs) this.map.set(k, { ...entry, lastSeen: entry.updated });
        } catch { /* a torn last line after a crash */ }
      }
      while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
      // Rewrite one line per live session so the file doesn't grow forever.
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, [...this.map].map(([k, { lastSeen, ...e }]) => `${JSON.stringify({ k, ...e })}\n`).join(''), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      this.onError(err);
    }
  }
}
