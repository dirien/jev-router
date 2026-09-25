// The live view: a page that shows routing as it happens, and a stream of the router's log entries
// for it as server-sent events. `jev-router serve --ui` feeds it in-process; `jev-router ui` feeds it
// by following a log file. It only shows log entries, which hold no prompt text and no keys, and it
// listens on loopback unless it is given another address.

import { createHash, timingSafeEqual } from 'node:crypto';
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
const LOOPBACK = '127.0.0.1';
/** Host names that always mean this machine. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const WILDCARDS = new Set(['0.0.0.0', '::']);
/** The paths that show routing, and so need the token when the view has one. The page's code, style and icon don't. */
const GUARDED = new Set(['/', '/index.html', '/events']);
/** The longest line kept. The router's own lines are far shorter. */
const MAX_LINE = 64 * 1024;
/** The most read from the log in one poll; a larger backlog is read over several polls. */
const MAX_READ = 4 * 1024 * 1024;
/** A page that stops reading is dropped once this much is queued for it. */
const MAX_QUEUED = 1024 * 1024;
/** Open pages at most. A person has a few; every one gets the whole history when it connects. */
const MAX_CLIENTS = 32;

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

/** @param {string} host */
const bracketed = (host) => (host.includes(':') ? `[${host}]` : host);

/**
 * The host names a view listening on `host` answers to. Loopback names always work: a port
 * forwarded to the view (`sbx ports`) arrives addressed to 127.0.0.1 or localhost. A specific
 * address works too; a wildcard adds nothing, so a DNS-rebinding page can't reach the view.
 * @param {string} host the address the view listens on
 * @returns {ReadonlySet<string>}
 */
export function hostNamesFor(host) {
  return WILDCARDS.has(host) ? LOOPBACK_NAMES : new Set([...LOOPBACK_NAMES, bracketed(host).toLowerCase()]);
}

/**
 * The host name in a Host header, without its port: `[::1]:4100` gives `[::1]`.
 * @param {string} host
 * @returns {string | undefined} undefined when the header isn't a host
 */
function hostName(host) {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Why a request is refused, if it is. The Host must name an address the view answers to, on any
 * port, since a forwarded port keeps the host's port. An Origin, when there is one, must be the
 * page's own. Only GET and HEAD are served.
 * @param {IncomingMessage} req
 * @param {ReadonlySet<string>} names
 * @returns {{ status: number, message: string } | undefined}
 */
function refusal(req, names) {
  const host = req.headers.host ?? '';
  const name = hostName(host);
  if (name === undefined || !names.has(name)) return { status: 403, message: `Host "${host}" is not allowed` };
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
 * @param {Record<string, string>} [headers] more response headers
 */
async function sendAsset(res, path, headOnly, headers = {}) {
  /** @type {Buffer} */
  let body;
  try {
    body = await readFile(path);
  } catch {
    return reply(res, 404, 'Not found');
  }
  res.writeHead(200, {
    ...HEADERS,
    ...headers,
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'content-length': body.length,
  });
  res.end(headOnly ? undefined : body);
}

/** @param {string} value */
const digest = (value) => createHash('sha256').update(value).digest();

/**
 * One cookie's value from a Cookie header.
 * @param {string | undefined} header
 * @param {string} name
 * @returns {string | undefined}
 */
function readCookie(header, name) {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined; // not a value this view set
    }
  }
  return undefined;
}

/**
 * The cookie that carries the token, named after the port the browser sees: views on other ports
 * of the same host (forwarded from several sandboxes, say) keep their own.
 * @param {string} host the request's Host header, already checked
 */
const cookieName = (host) => `jev-router-ui-${new URL(`http://${host}`).port || '80'}`;

/**
 * Where a request carries the view's token, compared in constant time: its query, or the cookie
 * the page set.
 * @param {IncomingMessage} req
 * @param {URLSearchParams} query
 * @param {Buffer} expected the token's digest
 * @returns {'query' | 'cookie' | undefined} undefined when it doesn't
 */
function tokenFrom(req, query, expected) {
  const given = query.get('token');
  if (given !== null && timingSafeEqual(digest(given), expected)) return 'query';
  const saved = readCookie(req.headers.cookie, cookieName(req.headers.host ?? ''));
  if (saved !== undefined && timingSafeEqual(digest(saved), expected)) return 'cookie';
  return undefined;
}

/**
 * Creates the live view: the page, and a stream of log entries for it at `/events`. Entries come
 * from `publish`, and from `file` when one is given. A page that connects gets the recent entries as
 * one `snapshot` event, then each new one as a message.
 * @param {UiOptions} [options]
 * @returns {UiServer}
 */
export function createUiServer({
  file,
  pollMs,
  backlogBytes,
  history = 2000,
  heartbeatMs = 15000,
  assets = ASSET_DIR,
  maxClients = MAX_CLIENTS,
  token,
} = {}) {
  const expected = token === undefined ? undefined : digest(token);
  /** @type {UiEvent[]} */
  const recent = [];
  /** @type {Set<ServerResponse>} */
  const clients = new Set();
  /** @type {NodeJS.Timeout | undefined} */
  let heartbeat;
  /** @type {ReadonlySet<string>} the host names the Host header may carry; set by `listen` */
  let names = LOOPBACK_NAMES;

  /** @param {string} chunk */
  const send = (chunk) => {
    for (const res of clients) {
      if (res.writableLength > MAX_QUEUED) {
        clients.delete(res);
        res.destroy();
      } else res.write(chunk);
    }
  };

  /** @param {unknown} entry */
  const publish = (entry) => {
    if (!isEvent(entry)) return;
    recent.push(entry);
    if (recent.length > history) recent.splice(0, recent.length - history);
    send(`data: ${JSON.stringify(entry)}\n\n`);
  };

  const tail =
    file === undefined
      ? undefined
      : new LogTail(file, {
          pollMs,
          backlogBytes,
          onLines: (lines) => {
            for (const line of lines) publish(parseLogLine(line));
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
    res.write(
      `retry: 2000\n\nevent: snapshot\ndata: ${JSON.stringify({ file: file === undefined ? '' : basename(file), events: recent })}\n\n`,
    );
    clients.add(res);
    res.on('close', () => clients.delete(res));
  };

  /**
   * The token check for the paths that show routing, when the view has a token.
   * @param {IncomingMessage} req
   * @param {string} path
   * @param {string} search the query, without its `?`
   * @returns {Record<string, string> | undefined} headers for the response, or undefined when the token is missing or wrong
   */
  const admit = (req, path, search) => {
    if (!expected || !GUARDED.has(path)) return {};
    const found = tokenFrom(req, new URLSearchParams(search), expected);
    if (!found) return undefined;
    // The page opened with ?token= keeps it in a cookie, for a reload once the address is clean.
    if (found === 'query' && path !== '/events')
      return {
        'set-cookie': `${cookieName(req.headers.host ?? '')}=${encodeURIComponent(String(token))}; HttpOnly; SameSite=Strict; Path=/`,
      };
    return {};
  };

  const server = http.createServer((req, res) => {
    const refused = refusal(req, names);
    if (refused) return reply(res, refused.status, refused.message);
    const target = req.url ?? '/';
    const mark = target.indexOf('?');
    const path = mark < 0 ? target : target.slice(0, mark);
    const headers = admit(req, path, mark < 0 ? '' : target.slice(mark + 1));
    if (!headers) return reply(res, 401, 'This live view needs its token: open the address jev-router printed, which ends in ?token=');
    if (path === '/events' && req.method !== 'GET') return reply(res, 405, 'Use GET for /events');
    if (path === '/events' && clients.size >= maxClients) return reply(res, 503, `Too many open pages (${maxClients}): close one`);
    if (path === '/events') return subscribe(res);
    const asset = ASSETS[path];
    if (!asset) return reply(res, 404, 'Not found');
    void sendAsset(res, join(assets, asset), req.method === 'HEAD', headers);
  });

  return {
    publish,
    async listen(wanted, host = LOOPBACK) {
      names = hostNamesFor(host);
      await tail?.start();
      try {
        await new Promise((done, fail) => {
          server.once('error', fail);
          server.listen(wanted, host, () => {
            server.off('error', fail);
            done(undefined);
          });
        });
      } catch (err) {
        tail?.stop();
        throw err;
      }
      heartbeat = setInterval(() => send(': keep-alive\n\n'), heartbeatMs).unref();
      return `http://${WILDCARDS.has(host) ? LOOPBACK : bracketed(host)}:${port()}/`;
    },
    async close() {
      tail?.stop();
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
