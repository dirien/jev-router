// The live view: following a log, turning its lines into events, and serving the page and the
// event stream to this machine's browser only. Local files and ports only, no network.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createUiServer, hostNamesFor, LogTail, parseLogLine } from '../src/ui.mjs';
import { sleep } from './helpers.mjs';

const dir = mkdtempSync(join(tmpdir(), 'jev-router-ui-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** @param {Record<string, unknown>} entry */
const line = (entry) => `${JSON.stringify(entry)}\n`;

/**
 * Waits until `check` holds, polling every 10 ms for up to 3 s.
 * @param {() => boolean} check
 * @param {string} what
 */
async function until(check, what) {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * One request to the view, with the Host and Origin a browser would send.
 * @param {number} port
 * @param {string} path
 * @param {{ method?: string, host?: string, origin?: string }} [options]
 * @returns {Promise<{ status: number | undefined, headers: http.IncomingHttpHeaders, body: string }>}
 */
function request(port, path, { method = 'GET', host = `127.0.0.1:${port}`, origin } = {}) {
  return new Promise((done, fail) => {
    /** @type {Record<string, string>} */
    const headers = { host };
    if (origin) headers.origin = origin;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', fail);
    req.end();
  });
}

/**
 * Opens the event stream and collects what arrives.
 * @param {number} port
 */
async function subscribe(port) {
  const state = { text: '', ended: false };
  /** @type {http.ClientRequest} */
  const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { host: `127.0.0.1:${port}` } });
  const res = await new Promise((done) => req.on('response', done));
  res.setEncoding('utf8');
  res.on('data', (/** @type {string} */ chunk) => {
    state.text += chunk;
  });
  res.on('end', () => {
    state.ended = true;
  });
  return { res, state, close: () => req.destroy() };
}

/**
 * The events of a stream so far: the snapshot's events, then each message.
 * @param {string} text
 */
function messages(text) {
  /** @type {Array<{ event?: string, data: unknown }>} */
  const out = [];
  for (const block of text.split('\n\n')) {
    const name = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (data) out.push({ event: name, data: JSON.parse(data) });
  }
  return out;
}

test('parseLogLine keeps the router entries and shows its other output as text', () => {
  const now = () => '2026-09-24T12:00:00.000Z';
  assert.deepEqual(parseLogLine('{"event":"route","tier":"fast"}', now), { event: 'route', tier: 'fast' });
  assert.deepEqual(parseLogLine('jev-router: config reloaded\r', now), { ts: now(), event: 'text', text: 'jev-router: config reloaded' });
  assert.equal(parseLogLine('   ', now), undefined);
  for (const odd of ['{"no":"event"}', '{broken', '[1,2]', '{"event":7}']) assert.equal(parseLogLine(odd, now)?.event, 'text', odd);
  const long = /** @type {{ text?: string } | undefined} */ (parseLogLine('x'.repeat(2000), now));
  assert.equal(long?.text?.length, 500, 'long text is cut');
  assert.equal(parseLogLine(`{"event":"a","pad":"${'x'.repeat(70000)}"}`, now)?.event, 'text', 'an oversized line is not parsed');
});

test('LogTail replays the end of a log, then follows appends, cut lines, truncation and replacement', async (t) => {
  const file = join(dir, 'tail.log');
  writeFileSync(file, `${'x'.repeat(100)}\n${line({ event: 'a' })}`);
  /** @type {string[]} */
  const seen = [];
  const tail = new LogTail(file, { onLines: (lines) => seen.push(...lines), pollMs: 60000, backlogBytes: 40 });
  t.after(() => tail.stop());
  await tail.start();
  assert.deepEqual(seen, ['{"event":"a"}'], 'the backlog starts mid-file and drops the line it cuts');

  appendFileSync(file, '{"event":');
  await tail.poll();
  assert.equal(seen.length, 1, 'half a line waits for the rest');
  appendFileSync(file, '"b"}\n\n{"event":"c"}\n');
  await tail.poll();
  assert.deepEqual(seen.slice(1), ['{"event":"b"}', '{"event":"c"}'], 'blank lines are skipped');

  const rocket = Buffer.from(line({ event: 'text', text: 'Grüße 🚀' }));
  appendFileSync(file, rocket.subarray(0, rocket.length - 6));
  await tail.poll();
  appendFileSync(file, rocket.subarray(rocket.length - 6));
  await tail.poll();
  assert.deepEqual(JSON.parse(seen[3]), { event: 'text', text: 'Grüße 🚀' }, 'a character split across reads survives');

  truncateSync(file, 0);
  appendFileSync(file, line({ event: 'd' }));
  await tail.poll();
  assert.deepEqual(seen.slice(4), ['{"event":"d"}'], 'a truncated log is read from its start');

  const next = join(dir, 'tail.next');
  writeFileSync(next, line({ event: 'e' }) + line({ event: 'f' }));
  renameSync(next, file);
  await tail.poll();
  assert.deepEqual(seen.slice(5), ['{"event":"e"}', '{"event":"f"}'], 'a replaced log is read from its start');

  appendFileSync(file, 'y'.repeat(70 * 1024));
  await tail.poll();
  appendFileSync(file, `\n${line({ event: 'g' })}`);
  await tail.poll();
  assert.deepEqual(seen.slice(7), ['{"event":"g"}'], 'a line with no end in sight is dropped, and the next line still arrives');
});

test('LogTail waits for a log that does not exist yet, and keeps polling on its own', async (t) => {
  const file = join(dir, 'later.log');
  /** @type {string[]} */
  const seen = [];
  const tail = new LogTail(file, { onLines: (lines) => seen.push(...lines), pollMs: 10 });
  t.after(() => tail.stop());
  await tail.start();
  assert.deepEqual(seen, []);
  writeFileSync(file, line({ event: 'x' }));
  await until(() => seen.length === 1, 'the timer to pick up the new log');
  rmSync(file);
  await tail.poll();
  assert.deepEqual(seen, ['{"event":"x"}']);
});

test('the view serves only its page files, with a strict CSP, and only to this machine', async () => {
  const file = join(dir, 'view.log');
  writeFileSync(file, '');
  const assets = mkdtempSync(join(dir, 'assets-'));
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>jev-router</title>');
  writeFileSync(join(assets, 'app.js'), 'export {};\n');
  const view = createUiServer({ file, assets, pollMs: 20 });
  const url = await view.listen(0);
  const port = Number(new URL(url).port);
  assert.equal(url, `http://127.0.0.1:${port}/`);

  const page = await request(port, '/');
  assert.equal(page.status, 200);
  assert.equal(page.body, '<!doctype html><title>jev-router</title>');
  assert.match(String(page.headers['content-type']), /^text\/html/);
  assert.match(
    String(page.headers['content-security-policy']),
    /^default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'/,
  );
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['cache-control'], 'no-store');
  const script = await request(port, '/app.js?v=1');
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
  const head = await request(port, '/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await request(port, '/app.css')).status, 404, 'a page file that is missing');
  assert.equal((await request(port, '/../package.json')).status, 404, 'nothing but the page files');
  assert.equal((await request(port, '/', { host: `rebind.example:${port}` })).status, 403, 'DNS rebinding');
  assert.equal((await request(port, '/events', { origin: 'https://evil.example' })).status, 403, 'another site');
  assert.equal(
    (await request(port, '/', { host: `localhost:${port}`, origin: `http://localhost:${port}` })).status,
    200,
    'the page itself',
  );
  assert.equal((await request(port, '/', { method: 'POST' })).status, 405);
  assert.equal((await request(port, '/events', { method: 'HEAD' })).status, 405);
  await view.close();
  await view.close(); // closing twice is harmless
});

test('a page gets the recent events as a snapshot, then each new line as it is written', async () => {
  const file = join(dir, 'stream.log');
  const lines = [line({ event: 'warning', message: 'old' }), line({ event: 'config', tiers: ['fast', 'frontier'] })];
  writeFileSync(file, `${lines.join('')}jev-router 1.0.0 listening on http://127.0.0.1:4000\n`);
  const view = createUiServer({ file, pollMs: 20, heartbeatMs: 40, history: 2 });
  const port = Number(new URL(await view.listen(0)).port);

  const page = await subscribe(port);
  assert.equal(page.res.headers['content-type'], 'text/event-stream; charset=utf-8');
  await until(() => page.state.text.includes('event: snapshot'), 'the snapshot');
  const [snapshot] = messages(page.state.text);
  assert.equal(snapshot.event, 'snapshot');
  const { file: shown, events } = /** @type {{ file: string, events: Array<Record<string, unknown>> }} */ (snapshot.data);
  assert.equal(shown, 'stream.log', 'the page learns the log name, not its path');
  assert.deepEqual(
    events.map((e) => e.event),
    ['config', 'text'],
    'history keeps the newest events',
  );
  assert.equal(events[1].text, 'jev-router 1.0.0 listening on http://127.0.0.1:4000');

  appendFileSync(file, line({ event: 'route', req: 1, tier: 'fast', model: 'claude-haiku-4-5' }));
  await until(() => messages(page.state.text).length === 2, 'the new route');
  assert.deepEqual(messages(page.state.text)[1], {
    event: undefined,
    data: { event: 'route', req: 1, tier: 'fast', model: 'claude-haiku-4-5' },
  });
  await until(() => page.state.text.includes(': keep-alive'), 'a keep-alive comment');
  assert.equal(view.clients, 1);

  const late = await subscribe(port);
  await until(() => late.state.text.includes('event: snapshot'), 'the second snapshot');
  const latest = /** @type {{ events: Array<Record<string, unknown>> }} */ (messages(late.state.text)[0].data).events;
  assert.deepEqual(
    latest.map((e) => e.event),
    ['text', 'route'],
    'a later page starts from the newest history',
  );
  late.close();
  await until(() => view.clients === 1, 'the closed page to be dropped');

  await view.close();
  await until(() => page.state.ended, 'close to end the open stream');
  assert.equal(view.clients, 0);
});

test('a view without a log shows what is published, and answers a port forwarded under another number', async () => {
  const view = createUiServer({ heartbeatMs: 1000 });
  view.publish({ ts: 't1', event: 'config', tiers: ['fast', 'frontier'] });
  view.publish({ no: 'event' });
  view.publish('jev-router: plain text is not an entry');
  const port = Number(new URL(await view.listen(0)).port);
  const page = await subscribe(port);
  await until(() => page.state.text.includes('event: snapshot'), 'the snapshot');
  const snapshot = /** @type {{ file: string, events: Array<Record<string, unknown>> }} */ (messages(page.state.text)[0].data);
  assert.equal(snapshot.file, '', 'no log file to name');
  assert.deepEqual(
    snapshot.events.map((e) => e.event),
    ['config'],
    'only entries are shown',
  );
  view.publish({ ts: 't2', event: 'route', req: 1, tier: 'fast' });
  await until(() => messages(page.state.text).length === 2, 'the published route');
  assert.equal(
    (await request(port, '/', { host: 'localhost:5100', origin: 'http://localhost:5100' })).status,
    200,
    'sbx ports 5100:<port>',
  );
  assert.equal((await request(port, '/', { host: `10.1.2.3:${port}` })).status, 403, 'an address the view does not listen on');
  assert.equal((await request(port, '/', { host: 'bad host' })).status, 403, 'a Host that is not a host');
  page.close();
  await view.close();
});

test('the view takes a bounded number of open pages', async () => {
  const view = createUiServer({ heartbeatMs: 1000, maxClients: 2 });
  const port = Number(new URL(await view.listen(0)).port);
  const pages = [await subscribe(port), await subscribe(port)];
  try {
    await until(() => view.clients === 2, 'two pages');
    const third = await subscribe(port);
    pages.push(third);
    assert.equal(third.res.statusCode, 503);
    await until(() => third.state.ended, 'the refusal to end');
    assert.match(third.state.text, /Too many open pages \(2\)/);
    pages[0].close();
    await until(() => view.clients === 1, 'a page to leave');
    pages.push(await subscribe(port));
    await until(() => view.clients === 2, 'a new page in its place');
  } finally {
    for (const page of pages) page.close();
    await view.close();
  }
});

test('hostNamesFor: loopback names always, the listening address too, and nothing more for a wildcard', () => {
  assert.deepEqual([...hostNamesFor('0.0.0.0')], ['127.0.0.1', 'localhost', '[::1]']);
  assert.deepEqual([...hostNamesFor('::')], ['127.0.0.1', 'localhost', '[::1]']);
  assert.deepEqual([...hostNamesFor('127.0.0.1')], ['127.0.0.1', 'localhost', '[::1]']);
  assert.ok(hostNamesFor('192.168.1.5').has('192.168.1.5'));
  assert.ok(hostNamesFor('FE80::1').has('[fe80::1]'), 'IPv6 in brackets, lower case, as URL gives it');
});

test('listen fails cleanly on a taken port', async () => {
  const file = join(dir, 'taken.log');
  const first = createUiServer({ file });
  const port = Number(new URL(await first.listen(0)).port);
  const second = createUiServer({ file });
  await assert.rejects(second.listen(port), /EADDRINUSE/);
  await second.close();
  await first.close();
});
