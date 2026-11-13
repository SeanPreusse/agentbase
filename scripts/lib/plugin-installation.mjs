import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
const exec = promisify(execFile);
export const PLUGIN_ID = 'agentbase@agentbase-local';
export async function codexJson(args, options = {}) {
  const { stdout } = await exec('codex', [...args, '--json'], { maxBuffer: 2 * 1024 * 1024, ...options });
  return JSON.parse(stdout);
}
export async function installedPlugin() {
  const listing = await codexJson(['plugin', 'list', '--marketplace', 'agentbase-local']);
  const plugin = listing.installed.find(p => p.pluginId === PLUGIN_ID);
  if (!plugin) throw new Error('Agentbase is not installed. Run npm run plugin:up first.');
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const root = await realpath(join(codexHome, 'plugins/cache/agentbase-local/agentbase', plugin.version));
  const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
  if (manifest.version !== plugin.version || manifest.name !== 'agentbase') throw new Error('Installed plugin manifest does not match the Codex inventory.');
  return { ...plugin, installedPath: root };
}
