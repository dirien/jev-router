// The router's addresses as clients see them, and the /healthz probe that tells a jev-router from
// anything else on a port.
import http from 'node:http';

/** @import { Health } from './types.js' */

/** The address the router and its live view listen on by default. */
export const LOOPBACK = '127.0.0.1';
/** The live view's default port. */
export const UI_PORT = 4100;
/** The header that carries the router token. */
export const TOKEN_HEADER = 'x-jev-router-token';

/**
 * @param {string | number} value
 * @returns {number} a TCP port; 0 asks the OS for any free one
 */
export function parsePort(value) {
  const port = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`port must be a number from 0 to 65535, got "${value}"`);
  return port;
}

/**
 * A host as it goes into a URL: an IPv6 address in brackets.
 * @param {string} host
 */
export const urlHost = (host) => (host.includes(':') ? `[${host}]` : host);
/**
 * The address a client on this machine uses for a router bound to `host`: one bound to every interface is reached on loopback.
 * @param {string} host
 */
export const clientHost = (host) => (host === '0.0.0.0' || host === '::' ? LOOPBACK : urlHost(host));
/** @param {string} host */
export const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1'].includes(host);

/**
 * @typedef {{ answered: boolean, health?: Health }} Probe
 */
/**
 * Asks whatever listens at `url` for jev-router's /healthz. It uses a plain agent because loopback
 * needs no proxy: with NODE_USE_ENV_PROXY=1 the default agent would send this to HTTP_PROXY.
 * @param {string} url
 * @returns {Promise<Probe>}
 */
export function probe(url) {
  return new Promise((done) => {
    const req = http.get(`${url}/healthz`, { agent: false, timeout: 1000 }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', () => done({ answered: true }));
      res.on('end', () => done({ answered: true, health: parseHealth(res.statusCode, Buffer.concat(chunks).toString()) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => done({ answered: false }));
  });
}

/**
 * @param {number | undefined} status
 * @param {string} text
 * @returns {Health | undefined} the health report, if a jev-router sent it
 */
function parseHealth(status, text) {
  try {
    const body = JSON.parse(text);
    return status === 200 && body?.ok === true && typeof body.jev === 'object' ? body : undefined;
  } catch {
    return undefined;
  }
}
