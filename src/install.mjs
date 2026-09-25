// Where the jev-router command comes from: a global install, or npx's cache, which npm may delete
// at any time. A background service needs the first kind, so `setup` can install it with npm, and
// the commands it suggests are the ones that work for this copy.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { findProgram, packaged, programCandidates, shellQuote } from './files.mjs';

/** The package's name on npm. */
export const PACKAGE = '@ediri/jev-router';
/** Its name up to 1.4.0. A global install from then owns the jev-router command, which npm won't hand over. */
export const LEGACY_PACKAGE = '@dirien/jev-router';
const NPX = `${sep}_npx${sep}`;

/**
 * A path with its symbolic links resolved, or as it is when it can't be.
 * @param {string} path
 */
function realpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The npx directory, `<npm cache>/_npx/<hash>`, that a file really lives in, if any.
 * @param {string} path
 * @returns {string | undefined}
 */
export function npxDirOf(path) {
  const real = realpath(path);
  const at = real.indexOf(NPX);
  if (at < 0) return undefined;
  const end = real.indexOf(sep, at + NPX.length);
  return end < 0 ? real : real.slice(0, end);
}

/**
 * The global jev-router a service can run: the first on PATH that doesn't live in npx's cache
 * (npx puts its own first on PATH).
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined} its path as found on PATH
 */
export function installedCommand(env) {
  return programCandidates('jev-router', env).find((path) => npxDirOf(path) === undefined);
}

/**
 * Whether two paths are the same file.
 * @param {string} a
 * @param {string} b
 */
export const sameFile = (a, b) => realpath(a) === realpath(b);

/**
 * @typedef {object} Origin
 * @property {string} [npx] the npx directory this copy runs from
 * @property {string} spec what `npm install -g` takes to install this copy for good
 * @property {string} [npxCommand] how to run this copy again through npx
 */

/**
 * Where this copy of jev-router runs from, and how npm installs the same package globally.
 * @param {string} version
 * @param {string} [script] this copy's command; tests pass another
 * @returns {Origin}
 */
export function origin(version, script = packaged('bin/jev-router.mjs')) {
  const npx = npxDirOf(script);
  if (!npx) return { spec: `${PACKAGE}@${version}` };
  const { spec, registry } = installSpec(recordedSpec(npx), npx, version);
  return { npx, spec, npxCommand: `npx ${registry ? PACKAGE : shellQuote(spec)}` };
}

/**
 * The spec npx recorded for the package in `<npx dir>/package.json`.
 * @param {string} npx
 * @returns {string | undefined}
 */
function recordedSpec(npx) {
  try {
    const spec = JSON.parse(readFileSync(join(npx, 'package.json'), 'utf8'))?.dependencies?.[PACKAGE];
    return typeof spec === 'string' ? spec : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What `npm install -g` takes for the package npx ran: a git or GitHub spec as npx recorded it, a
 * `file:` spec as an absolute path (npx records it relative to its own directory), and for the
 * registry, or when it can't tell, this version by name.
 * @param {string | undefined} recorded
 * @param {string} npx
 * @param {string} version
 * @returns {{ spec: string, registry: boolean }}
 */
export function installSpec(recorded, npx, version) {
  if (recorded?.startsWith('file:')) return { spec: resolve(npx, recorded.slice('file:'.length)), registry: false };
  const remote = /^(git\+|git:|github:|gitlab:|bitbucket:|gist:|https?:)/.test(recorded ?? '');
  const shorthand = /^[\w.-]+\/[\w.-]+(#.*)?$/.test(recorded ?? ''); // owner/repo, which npm reads as GitHub
  if (recorded && (remote || shorthand)) return { spec: recorded, registry: false };
  return { spec: `${PACKAGE}@${version}`, registry: true };
}

/**
 * Runs `npm install -g <spec>`, with npm's own output on this terminal.
 * @param {string} spec
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ ok: boolean, why: string }>}
 */
export function npmInstall(spec, env) {
  const npm = findProgram('npm', env);
  if (!npm) return Promise.resolve({ ok: false, why: "npm isn't on PATH" });
  return new Promise((done) => {
    const child = spawn(npm, ['install', '-g', spec], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', (err) => done({ ok: false, why: err.message }));
    child.on('exit', (code, signal) => done({ ok: code === 0, why: signal ? `npm was stopped by ${signal}` : `npm exited with ${code}` }));
  });
}

/**
 * The version a jev-router command reports, or '' when it can't say.
 * @param {string} command
 * @param {NodeJS.ProcessEnv} env
 */
export function commandVersion(command, env) {
  const result = spawnSync(command, ['version'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
  return result.status === 0 ? result.stdout.trim() : '';
}

/**
 * The directory npm installs global packages under, from `npm prefix -g`.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
function npmPrefix(env) {
  const npm = findProgram('npm', env);
  if (!npm) return undefined;
  const result = spawnSync(npm, ['prefix', '-g'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

/**
 * The global jev-router after an install: on PATH, or in npm's global bin directory when that isn't on PATH.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ path: string, onPath: boolean } | undefined}
 */
export function globalCommand(env) {
  const onPath = installedCommand(env);
  if (onPath) return { path: onPath, onPath: true };
  const prefix = npmPrefix(env);
  const bin = prefix && findProgram(join(prefix, 'bin', 'jev-router'), env);
  return bin && !npxDirOf(bin) ? { path: bin, onPath: false } : undefined;
}

/**
 * Whether the global jev-router is still 1.4.0's `@dirien/jev-router`, which npm won't replace.
 * @param {NodeJS.ProcessEnv} env
 */
export function legacyInstall(env) {
  const legacy = `${sep}node_modules${sep}${LEGACY_PACKAGE.replace('/', sep)}${sep}`;
  const found = installedCommand(env);
  if (found && realpath(found).includes(legacy)) return true;
  const prefix = npmPrefix(env);
  return prefix !== undefined && existsSync(join(prefix, 'lib', 'node_modules', ...LEGACY_PACKAGE.split('/')));
}
