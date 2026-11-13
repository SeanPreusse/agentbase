import { readFile, readdir, mkdir, copyFile, chmod, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startHost } from './lib/codex-host.mjs';
import { installedPlugin, codexJson, PLUGIN_ID } from './lib/plugin-installation.mjs';
const exec = promisify(execFile);
const source = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const command = process.argv[2] ?? 'status';
if (!['up', 'down', 'status'].includes(command)) throw new Error('Use up, down, or status.');

async function backupConfig() {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const directory = join(home, 'backups', `agentbase-${Date.now()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await copyFile(join(home, 'config.toml'), join(directory, 'config.toml')); await chmod(join(directory, 'config.toml'), 0o600); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return directory;
}
async function fingerprint(root) {
  const files = ['plugin.json', 'mcp.json', 'package-lock.json'];
  async function walk(directory) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  for (const directory of ['bin', 'dist', 'skills', 'assets']) await walk(directory);
  const digest = createHash('sha256');
  for (const path of files.sort()) { digest.update(path); digest.update('\0'); digest.update(await readFile(join(root, path))); digest.update('\0'); }
  return digest.digest('hex');
}
let backup;
if (command === 'down') {
  await installedPlugin();
  backup = await backupConfig();
  const host = await startHost({ cwd: source });
  try { await host.request('config/value/write', { keyPath: `plugins."${PLUGIN_ID}".enabled`, value: false, mergeStrategy: 'replace' }); }
  finally { await host.stop(); }
  const plugin = await installedPlugin();
  if (plugin.enabled) throw new Error('Codex still reports Agentbase as enabled.');
  console.log(JSON.stringify({ plugin: PLUGIN_ID, enabled: false, backup, note: 'Future Codex sessions will not start this plugin. Reconnect existing sessions to unload their MCP process.' }, null, 2));
} else {
  if (command === 'up') {
    await exec('npm', ['run', 'build'], { cwd: source });
    backup = await backupConfig();
    const marketplaces = await codexJson(['plugin', 'marketplace', 'list']);
    const marketplace = marketplaces.marketplaces.find(m => m.name === 'agentbase-local');
    if (marketplace) {
      if (await realpath(marketplace.root) !== source) throw new Error('agentbase-local points at another checkout. Explicitly replace that marketplace before installing from this repository.');
    } else await codexJson(['plugin', 'marketplace', 'add', source]);
    await codexJson(['plugin', 'add', PLUGIN_ID]);
  }
  const plugin = await installedPlugin();
  const sourceHash = await fingerprint(source), installedHash = await fingerprint(plugin.installedPath);
  if (command === 'up' && (!plugin.enabled || sourceHash !== installedHash)) throw new Error('The installed plugin did not refresh to the built checkout. The plugin cache is stale; do not use it until refreshed.');
  console.log(JSON.stringify({ plugin: PLUGIN_ID, version: plugin.version, enabled: plugin.enabled, installedPath: plugin.installedPath,
    matches_checkout: sourceHash === installedHash, ...(backup ? { backup } : {}),
    note: 'Reconnect Codex or start a new session to load this installed build. Existing processes do not hot-reload compiled code.' }, null, 2));
}
