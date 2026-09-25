// `jev-router uninstall` undoes `jev-router setup`: it stops and removes the service, and takes
// setup's variables back out of Claude Code's settings, from the manifest setup keeps. It keeps the
// config, the keys and the logs, and running it twice is fine.
import { existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CLAUDE_SETTINGS,
  changeSettingsEnv,
  hasTokenLine,
  pointsAtRouter,
  readSettings,
  recordedValues,
  settingsBlock,
  withoutHeader,
  writeSettings,
} from './claude.mjs';
import { loadConfig } from './config.mjs';
import { envFilePath, loadEnvFile } from './envfile.mjs';
import { claudeSettingsPath, configFile, NO_ENV_FILE, routerLogPath, setupManifestPath, shellQuote, userConfigPath } from './files.mjs';
import { PACKAGE } from './install.mjs';
import { TOKEN_HEADER } from './net.mjs';
import { installedServices, MANAGER_NAMES, stopService } from './service.mjs';
import { inWords, readManifest, refuseRoot, writeManifest } from './setup.mjs';

/** @import { Manifest } from './setup.mjs' */

/** @param {string} text */
const say = (text) => process.stderr.write(text);

/**
 * `jev-router uninstall`: stops and removes the service, takes back what setup put into Claude
 * Code's settings, and keeps the config, the keys and the logs. Running it twice is fine.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
export async function runUninstall(env) {
  const refusal = refuseRoot('uninstall', env);
  if (refusal) {
    say(refusal);
    return 1;
  }
  try {
    loadEnvFile(undefined, env); // JEV_ROUTER_HOST and JEV_ROUTER_PORT, to tell the router's base URL
  } catch {
    // an env file that can't be read changes nothing here
  }
  const manifest = readManifest(env);
  const settingsDone = undoSettings(manifest, env);
  let failed = !settingsDone;
  const services = installedServices(env, manifest?.service);
  for (const { manager, file } of services) {
    const problems = stopService(manager, file, env);
    say(`Stopped and removed the ${MANAGER_NAMES[manager]} ${file}.\n`);
    for (const problem of problems) say(`  ${problem}\n`);
    failed ||= problems.length > 0;
  }
  if (!services.length) say('No background service is installed.\n');
  if (settingsDone) rmSync(setupManifestPath(env), { force: true });
  else if (manifest?.claude) {
    // Keep setup's record of Claude Code's settings, so a later uninstall can still take them back.
    writeManifest(env, { files: manifest.files, claude: manifest.claude });
    say(`Kept ${setupManifestPath(env)}, so that jev-router uninstall can finish once the settings file is fixed.\n`);
  }
  keptFiles(manifest, env);
  return failed ? 1 : 0;
}

/**
 * Takes setup's variables back out of Claude Code's settings: what the manifest recorded, where the
 * value is still the one setup wrote. Without a manifest, only a base URL that points at the router
 * goes, with the gateway settings that hold exactly setup's values. With a manifest that records
 * nothing there, as after `setup --no-claude-settings`, the settings stay as they are.
 * @param {Manifest | undefined} manifest
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean} false when the settings file couldn't be changed
 */
function undoSettings(manifest, env) {
  if (manifest && !manifest.claude) {
    say("Setup didn't change Claude Code's settings.\n");
    return true;
  }
  const file = manifest?.claude?.file ?? claudeSettingsPath(env);
  const read = readSettings(file);
  if ('problem' in read) {
    say(`Couldn't change ${file}: ${read.problem}. Fix it, then run jev-router uninstall again.\n`);
    return false;
  }
  const block = settingsBlock(read.data);
  const values = manifest?.claude ? recordedValues(manifest.claude, block) : guessedValues(block, env);
  const changes = changeSettingsEnv(read.data, values);
  if (!changes.length) {
    say(`Nothing from setup in Claude Code's settings (${file}).\n`);
    return true;
  }
  if (manifest?.claude?.created && !Object.keys(read.data).length) {
    rmSync(file, { force: true });
    say(`Removed ${file}, which setup had created. Restart any Claude Code session that's running.\n`);
    return true;
  }
  writeSettings(file, read, `${file}.jev-router.bak`);
  const restored = changes.filter((c) => c.after !== undefined).map((c) => c.name);
  const removed = changes.filter((c) => c.after === undefined).map((c) => c.name);
  const what = [removed.length ? `removed ${inWords(removed)}` : '', restored.length ? `restored ${inWords(restored)}` : ''];
  say(
    `Claude Code's settings (${file}): ${what.filter(Boolean).join('; ')}. ` +
      `The old file is ${file}.jev-router.bak. Restart any Claude Code session that's running.\n`,
  );
  return true;
}

/**
 * Without a manifest: nothing, unless the base URL points at the router. Then it goes, and so do
 * the gateway settings that hold exactly setup's values, and the router token's header line.
 * @param {Record<string, string>} block
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, string | undefined>}
 */
function guessedValues(block, env) {
  let cfg = { host: '127.0.0.1', port: 4000 };
  try {
    cfg = loadConfig(configFile(undefined, env).path);
  } catch {
    // the default address is the best guess left
  }
  const base = block.ANTHROPIC_BASE_URL;
  if (base === undefined || !pointsAtRouter(base, cfg, env)) return {};
  /** @type {Record<string, string | undefined>} */
  const values = { ANTHROPIC_BASE_URL: undefined };
  for (const [name, [wanted]] of Object.entries(CLAUDE_SETTINGS)) if (block[name] === wanted) values[name] = undefined;
  if (hasTokenLine(block.ANTHROPIC_CUSTOM_HEADERS))
    values.ANTHROPIC_CUSTOM_HEADERS = withoutHeader(block.ANTHROPIC_CUSTOM_HEADERS, TOKEN_HEADER).join('\n') || undefined;
  return values;
}

/**
 * Says what uninstall kept, and how to remove it and the command.
 * @param {Manifest | undefined} manifest
 * @param {NodeJS.ProcessEnv} env
 */
function keptFiles(manifest, env) {
  const configDir = dirname(userConfigPath(env));
  const stateDir = dirname(routerLogPath(env));
  const files = [manifest?.files?.config, manifest?.files?.env ?? envFilePath(env), manifest?.files?.log].filter(
    /** @returns {file is string} */ (file) => typeof file === 'string' && file !== NO_ENV_FILE,
  );
  const outside = files.filter((file) => !file.startsWith(`${configDir}/`) && !file.startsWith(`${stateDir}/`));
  const all = [configDir, stateDir, ...new Set(outside)].filter((path) => existsSync(path));
  if (all.length)
    say(
      `\nKept your config, keys and logs:\n${all.map((path) => `  ${path}\n`).join('')}` +
        `To delete them too: rm -rf ${all.map(shellQuote).join(' ')}\n`,
    );
  say(`Last step, to remove the jev-router command: npm uninstall -g ${PACKAGE}\n`);
}
