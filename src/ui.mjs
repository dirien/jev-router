// jev-router ui: a live view of a router log in the browser. It follows the log file and streams
// each new line to the page as a server-sent event. It only reads the log, which holds no prompt
// text and no keys, and it listens on loopback only.

import { open, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { basename, extname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

/** @import { IncomingMessage, ServerResponse } from 'node:http' */
/** @import { Stats } from 'node:fs' */
/** @import { UiEvent, UiOptions, UiServer } from './types.js' */

const ASSET_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
/** @type {Record<string, string>} The page's files; nothing else is served. */
const ASSETS = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.css': 'app.css',
  '/app.js': 'app.js',
  '/favicon.svg': 'favicon.svg',
};
/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};
const HOST = '127.0.0.1';
/** The longest line kept. The router's own lines are far shorter. */
const MAX_LINE = 64 * 1024;
/** The most read from the log in one poll; a larger backlog is read over several polls. */
const MAX_READ = 4 * 1024 * 1024;
/** A page that stops reading is dropped once this much is queued for it. */
const MAX_QUEUED = 1024 * 1024;

/**
 * @param {unknown} value
 * @returns {value is UiEvent}
 */
const isEvent = (value) =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (/** @type {{ event?: unknown }} */ (value).event) === 'string';

/**
 * One log line as an event for the page: the router's JSON entries as they are, and anything else,
 * such as its plain-text messages on stderr, as a `text` event.
 * @param {string} line
 * @param {() => string} [now] the time for a `text` event
 * @returns {UiEvent | undefined} undefined for a blank line
 */
export function parseLogLine(line, now = () => new Date().toISOString()) {
  const text = line.trim();
  if (!text) return undefined;
  if (text.startsWith('{') && text.length <= MAX_LINE) {
    try {
      /** @type {unknown} */
      const value = JSON.parse(text);
      if (isEvent(value)) return value;
    } catch {
      // not JSON after all: shown as text below
    }
  }
  return { ts: now(), event: 'text', text: text.slice(0, 500) };
}

/**
 * Reads bytes [start, end) of a file.
 * @param {string} file
 * @param {number} start
 * @param {number} end
 * @returns {Promise<Buffer>}
 */
async function readRange(file, start, end) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Follows a growing file by polling. Polling also sees writes that arrive through a shared folder,
 * such as a Docker Sandbox workspace, where file-change events may never fire. A truncated or
 * replaced file is read again from its start.
 */
export class LogTail {
  #file;
  #onLines;
  #pollMs;
  #backlogBytes;
  #offset = 0;
  /** @type {number | undefined} */
  #inode;
  #partial = '';
  #decoder = new StringDecoder('utf8');
  /** Set when reading starts mid-file: the first line is cut and gets dropped. */
  #skipFirstLine = false;
  #busy = false;
  /** @type {NodeJS.Timeout | undefined} */
  #timer;
  /** @type {Promise<void>} */
  #reading = Promise.resolve();

  /**
   * @param {string} file
   * @param {{ onLines: (lines: string[]) => void, pollMs?: number, backlogBytes?: number }} options
   */
  constructor(file, { onLines, pollMs = 250, backlogBytes = 512 * 1024 }) {
    this.#file = file;
    this.#onLines = onLines;
    this.#pollMs = pollMs;
    this.#backlogBytes = backlogBytes;
  }

  /** Replays the last `backlogBytes` of the file, then looks for new lines every `pollMs`. */
  async start() {
    const info = await this.#stat();
    if (info && info.size > this.#backlogBytes) {
      this.#offset = info.size - this.#backlogBytes;
      this.#skipFirstLine = true;
    }
    await this.poll();
    this.#timer = setInterval(() => {
      if (!this.#busy) void this.poll();
    }, this.#pollMs);
    this.#timer.unref(); // whatever serves the lines keeps the process alive, not the polling
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Reads what was appended since the last read. Calls run one after another, never at once.
   * @returns {Promise<void>}
   */
  poll() {
    this.#reading = this.#reading.then(() => this.#read());
    return this.#reading;
  }

  /** @returns {Promise<Stats | undefined>} undefined while the file doesn't exist */
  #stat() {
    return stat(this.#file).catch(() => undefined);
  }

  async #read() {
    this.#busy = true;
    try {
      const info = await this.#stat();
      if (!info) return; // not there yet, or moved away
      if (info.ino !== this.#inode && this.#inode !== undefined)
        this.#restart(); // replaced
      else if (info.size < this.#offset) this.#restart(); // truncated
      this.#inode = info.ino;
      if (info.size <= this.#offset) return;
      const bytes = await readRange(this.#file, this.#offset, Math.min(info.size, this.#offset + MAX_READ));
      this.#offset += bytes.length;
      this.#take(this.#decoder.write(bytes));
    } catch {
      // The file can vanish between stat and read; the next poll tries again.
    } finally {
      this.#busy = false;
    }
  }

  #restart() {
    this.#offset = 0;
    this.#partial = '';
    this.#decoder = new StringDecoder('utf8');
    this.#skipFirstLine = false;
  }

  /** @param {string} text */
  #take(text) {
    const lines = `${this.#partial}${text}`.split('\n');
    this.#partial = lines.pop() ?? '';
    if (this.#partial.length > MAX_LINE) this.#partial = ''; // no newline in sight: not a log line
    if (this.#skipFirstLine && lines.length > 0) {
      lines.shift();
      this.#skipFirstLine = false;
    }
    const complete = lines.filter((line) => line.trim());
    if (complete.length > 0) this.#onLines(complete);
  }
}

/**
 * Why a request is refused, if it is. Only a page this server served may read it (no other Host,
 * which stops DNS rebinding, and no other Origin), and only with GET or HEAD.
 * @param {IncomingMessage} req
 * @param {number} port
 * @returns {{ status: number, message: string } | undefined}
 */
function refusal(req, port) {
  const host = req.headers.host ?? '';
  if (!['127.0.0.1', 'localhost', '[::1]'].some((name) => host === `${name}:${port}`))
    return { status: 403, message: `Host "${host}" is not allowed` };
  if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)
    return { status: 403, message: 'Cross-origin requests are not allowed' };
  if (req.method !== 'GET' && req.method !== 'HEAD') return { status: 405, message: `${req.method} is not allowed` };
  return undefined;
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {string} message
 */
function reply(res, status, message) {
  res.writeHead(status, { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${message}\n`);
}

/**
 * @param {ServerResponse} res
 * @param {string} path
 * @param {boolean} headOnly
 */
async function sendAsset(res, path, headOnly) {
  /** @type {Buffer} */
  let body;
  try {
    body = await readFile(path);
  } catch {
    return reply(res, 404, 'Not found');
  }
  res.writeHead(200, { ...HEADERS, 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'content-length': body.length });
  res.end(headOnly ? undefined : body);
}

/**
 * Creates the live view: the page, and a stream of the router log's events for it at `/events`.
 * A page that connects gets the recent events as one `snapshot` event, then each new one as a message.
 * @param {UiOptions} options
 * @returns {UiServer}
 */
export function createUiServer({ file, pollMs, backlogBytes, history = 2000, heartbeatMs = 15000, assets = ASSET_DIR }) {
  /** @type {UiEvent[]} */
  const recent = [];
  /** @type {Set<ServerResponse>} */
  const clients = new Set();
  /** @type {NodeJS.Timeout | undefined} */
  let heartbeat;

  /** @param {string} chunk */
  const send = (chunk) => {
    for (const res of clients) {
      if (res.writableLength > MAX_QUEUED) {
        clients.delete(res);
        res.destroy();
      } else res.write(chunk);
    }
  };

  const tail = new LogTail(file, {
    pollMs,
    backlogBytes,
    onLines: (lines) => {
      for (const line of lines) {
        const event = parseLogLine(line);
        if (!event) continue;
        recent.push(event);
        send(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (recent.length > history) recent.splice(0, recent.length - history);
    },
  });

  const port = () => {
    const address = server.address();
    return typeof address === 'object' && address ? address.port : 0;
  };

  /**
   * @param {ServerResponse} res
   */
  const subscribe = (res) => {
    res.writeHead(200, {
      ...HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 2000\n\nevent: snapshot\ndata: ${JSON.stringify({ file: basename(file), events: recent })}\n\n`);
    clients.add(res);
    res.on('close', () => clients.delete(res));
  };

  const server = http.createServer((req, res) => {
    const refused = refusal(req, port());
    if (refused) return reply(res, refused.status, refused.message);
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/events') return req.method === 'GET' ? subscribe(res) : reply(res, 405, 'Use GET for /events');
    const asset = ASSETS[path];
    if (!asset) return reply(res, 404, 'Not found');
    void sendAsset(res, join(assets, asset), req.method === 'HEAD');
  });

  return {
    async listen(wanted) {
      await tail.start();
      try {
        await new Promise((done, fail) => {
          server.once('error', fail);
          server.listen(wanted, HOST, () => {
            server.off('error', fail);
            done(undefined);
          });
        });
      } catch (err) {
        tail.stop();
        throw err;
      }
      heartbeat = setInterval(() => send(': keep-alive\n\n'), heartbeatMs).unref();
      return `http://${HOST}:${port()}/`;
    },
    async close() {
      tail.stop();
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
      if (server.listening) await new Promise((done) => server.close(() => done(undefined)));
    },
    get clients() {
      return clients.size;
    },
  };
}
