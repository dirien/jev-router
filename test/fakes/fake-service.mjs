#!/usr/bin/env node
// Stands in for `launchctl` and `systemctl` in test/cli.test.mjs, so the tests never touch the real
// service managers. It records every call, and it runs the service the way the real one would: from
// the installed plist's ProgramArguments or the unit's ExecStart, with only the PATH the file sets
// and HOME, detached, so a test proves that the file setup wrote starts a router. The copy's name
// says which tool it is. Its settings come from the environment:
//   FAKE_SERVICE_LOG    JSON lines file to append { tool, args } to (required); the router's PID
//                       and the fake journal go next to it
//   FAKE_SERVICE_START  "0": don't start the router, as for a service that fails at once
//   FAKE_SYSTEMD        "down": `systemctl --user show-environment` fails, as in a container;
//                       "refuses": `systemctl --user enable` fails
//   FAKE_LAUNCHD        "busy": the first `launchctl bootstrap` fails, as while launchd still unloads the agent
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const tool = basename(process.argv[1] ?? '');
const args = process.argv.slice(2);
const log = process.env.FAKE_SERVICE_LOG;
if (!log) throw new Error('FAKE_SERVICE_LOG is not set');
appendFileSync(log, `${JSON.stringify({ tool, args })}\n`);
const pidFile = join(dirname(log), 'fake-service.pid');
const loaded = join(dirname(log), 'fake-launchd-loaded');

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stops the router the service runs, and waits until it's gone, as a restart does. */
async function stopRouter() {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  rmSync(pidFile, { force: true });
  try {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 100; i += 1) {
      process.kill(pid, 0);
      await sleep(50);
    }
  } catch {
    // it's gone
  }
}

/**
 * Starts the service's command with the environment a service manager gives it.
 * @param {string[]} argv
 * @param {string} path
 * @param {string} errors where its stderr goes
 */
function startRouter(argv, path, errors) {
  if (process.env.FAKE_SERVICE_START === '0') return;
  const child = spawn(argv[0], argv.slice(1), {
    env: { PATH: path, HOME: homedir() },
    detached: true,
    stdio: ['ignore', 'ignore', openSync(errors, 'a')],
  });
  writeFileSync(pidFile, String(child.pid));
  child.unref();
}

/** @param {string} text */
const unxml = (text) => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

/** @param {string} file */
function plist(file) {
  const text = readFileSync(file, 'utf8');
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '';
  const argv = [...array.matchAll(/<string>(.*?)<\/string>/g)].map((m) => unxml(m[1]));
  const path = unxml(/<key>PATH<\/key>\s*<string>(.*?)<\/string>/.exec(text)?.[1] ?? '');
  const errors = unxml(/<key>StandardErrorPath<\/key>\s*<string>(.*?)<\/string>/.exec(text)?.[1] ?? '');
  return { argv, path, errors };
}

/**
 * A systemd value: C escapes inside quotes, %% and %h specifiers, and $$ for a dollar sign.
 * @param {string} text
 */
const systemd = (text) =>
  text
    .replace(/\\(.)/g, '$1')
    .replace(/%(.)/g, (_all, c) => (c === 'h' ? homedir() : c))
    .replaceAll('$$', '$');

/** @param {string} file */
function unit(file) {
  const text = readFileSync(file, 'utf8');
  const exec = /^ExecStart=(.*)$/m.exec(text)?.[1] ?? '';
  const argv = [...exec.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => systemd(m[1] ?? m[2]));
  const path = systemd(/^Environment="PATH=((?:[^"\\]|\\.)*)"$/m.exec(text)?.[1] ?? '');
  return { argv, path };
}

const unitFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', 'jev-router.service');

/** @returns {Promise<number>} the exit code */
async function launchctl() {
  const [command, target, file] = args;
  if (command === 'bootout') {
    if (!existsSync(loaded)) {
      process.stderr.write(`Boot-out failed: 3: No such process\n`);
      return 3;
    }
    await stopRouter();
    rmSync(loaded);
    return 0;
  }
  if (command === 'bootstrap') {
    const busy = join(dirname(log ?? ''), 'fake-launchd-was-busy');
    if (process.env.FAKE_LAUNCHD === 'busy' && !existsSync(busy)) {
      writeFileSync(busy, '');
      process.stderr.write('Bootstrap failed: 5: Input/output error\n');
      return 5;
    }
    if (existsSync(loaded)) {
      process.stderr.write('Bootstrap failed: 5: Input/output error\n');
      return 5;
    }
    if (!target?.startsWith('gui/')) return 64;
    const service = plist(file);
    startRouter(service.argv, service.path, service.errors);
    writeFileSync(loaded, file);
  }
  return 0;
}

/** @returns {Promise<number>} the exit code */
async function systemctl() {
  const [user, command] = args;
  if (user !== '--user') return 64;
  if (command === 'show-environment') {
    if (process.env.FAKE_SYSTEMD === 'down') {
      process.stderr.write('Failed to connect to bus: No medium found\n');
      return 1;
    }
    process.stdout.write(`HOME=${homedir()}\n`);
  }
  if (command === 'enable' && process.env.FAKE_SYSTEMD === 'refuses') {
    process.stderr.write('Failed to enable unit: Access denied\n');
    return 1;
  }
  if (command === 'enable' && !existsSync(unitFile())) {
    process.stderr.write('Failed to enable unit: Unit file jev-router.service does not exist.\n');
    return 1;
  }
  if (command === 'restart') {
    await stopRouter();
    const service = unit(unitFile());
    startRouter(service.argv, service.path, join(dirname(log ?? ''), 'fake-journal.log'));
  }
  if (command === 'disable' && args.includes('--now')) await stopRouter();
  return 0;
}

process.exitCode = await (tool === 'launchctl' ? launchctl() : systemctl());
