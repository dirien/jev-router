// Command-line entry point: `jev-router [serve] | report [log] | version`.
import { appendFileSync, readFileSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { createRouter, report, VERSION } from './router.mjs';

const DEFAULT_CONFIG = new URL('../config/default.json', import.meta.url);

/**
 * Runs a jev-router command.
 * @param {string[]} argv arguments after the program name
 * @returns {Promise<number | undefined>} exit code for one-shot commands; undefined while serving
 */
export async function main(argv) {
  const [command = 'serve', ...rest] = argv;
  const configPath = process.env.JEV_ROUTER_CONFIG ?? DEFAULT_CONFIG;
  if (command === 'version' || command === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === 'report') {
    const file = rest[0] ?? loadConfig(configPath).logFile;
    if (!file) throw new Error('Usage: jev-router report <log.jsonl> (or set logFile in the config)');
    process.stdout.write(`${JSON.stringify(report(readFileSync(file, 'utf8').split('\n')), null, 2)}\n`);
    return 0;
  }
  if (command !== 'serve') throw new Error(`Unknown command "${command}". Try: serve, report, version.`);
  serve(configPath);
  return undefined;
}

/** @param {string | URL} configPath */
function serve(configPath) {
  let cfg = loadConfig(configPath);
  const host = process.env.JEV_ROUTER_HOST ?? cfg.host;
  const port = Number(process.env.JEV_ROUTER_PORT ?? cfg.port);
  cfg = { ...cfg, host, port };
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!loopback && !(process.env.JEV_ROUTER_TOKEN ?? cfg.token))
    throw new Error(`Refusing to listen on ${host} without a token: set JEV_ROUTER_TOKEN.`);
  let stdoutBroken = false;
  process.stdout.on('error', () => {
    stdoutBroken = true; // a closed log pipe must not crash the router
  });
  /** @param {Record<string, unknown>} entry */
  const log = (entry) => {
    const line = `${JSON.stringify(entry)}\n`;
    if (!stdoutBroken) process.stdout.write(line);
    if (cfg.logFile) {
      try {
        appendFileSync(cfg.logFile, line, { mode: 0o600 });
      } catch {
        // logging must not break routing
      }
    }
  };
  const server = createRouter(cfg, { log });
  server.listen(port, host, () => console.error(`jev-router ${VERSION} listening on http://${host}:${port}`));
  process.on('SIGHUP', () => {
    try {
      cfg = { ...loadConfig(configPath), host, port };
      server.reload(cfg);
      console.error('jev-router: config reloaded');
    } catch (err) {
      console.error(`jev-router: reload failed, keeping the old config\n${err instanceof Error ? err.message : err}`);
    }
  });
  const shutdown = () => {
    console.error(`jev-router: shutting down, waiting for ${server.active} request(s)`);
    server.close();
    const deadline = Date.now() + 30000;
    const wait = setInterval(() => {
      if (server.active === 0 || Date.now() > deadline) {
        clearInterval(wait);
        process.exit(0);
      }
    }, 100);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
