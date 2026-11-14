import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

if (process.platform !== 'darwin') throw new Error('Build macOS releases on a Mac.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const releaseDir = join(root, 'build', 'release');
const app = join(releaseDir, 'AgentBase.app');
const resources = join(app, 'Contents', 'Resources');
const bundledPackage = join(resources, 'package');
const archivePath = join(releaseDir, `AgentBase-${manifest.version}-macos-${arch}.zip`);
const installerPath = join(releaseDir, `AgentBase-${manifest.version}-macos-${arch}.pkg`);
const scratch = await mkdtemp(join(tmpdir(), 'agentbase-release-'));

try {
  execFileSync(process.execPath, [join(root, 'scripts/native-ui.mjs')], { cwd: root, stdio: 'inherit' });
  await mkdir(releaseDir, { recursive: true });
  await rm(app, { recursive: true, force: true });
  await cp(join(root, 'build', 'Agentbase Inspector.app'), app, { recursive: true });

  const archive = execFileSync('npm', ['pack', '--pack-destination', scratch, '--silent'], { cwd: root, encoding: 'utf8' }).trim().split('\n').at(-1);
  if (!archive?.endsWith('.tgz')) throw new Error('npm pack did not produce an archive.');
  await mkdir(resources, { recursive: true });
  execFileSync('tar', ['-xzf', join(scratch, archive), '-C', resources], { stdio: 'inherit' });
  await mkdir(join(bundledPackage, '.agents', 'plugins'), { recursive: true });
  await cp(join(root, '.agents', 'plugins', 'marketplace.json'), join(bundledPackage, '.agents', 'plugins', 'marketplace.json'));
  await mkdir(join(bundledPackage, 'runtime'), { recursive: true });
  await cp(process.execPath, join(bundledPackage, 'runtime', 'node'));
  await cp(join(dirname(dirname(process.execPath)), 'LICENSE'), join(bundledPackage, 'runtime', 'NODE-LICENSE'));
  const mcp = JSON.parse(await readFile(join(bundledPackage, 'mcp.json'), 'utf8'));
  mcp.mcpServers.agentbase.command = './runtime/node';
  mcp.mcpServers.agentbase.args = ['./bin/agentbase.mjs', 'serve'];
  await writeFile(join(bundledPackage, 'mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
  await writeFile(join(resources, 'runtime.json'), JSON.stringify({ node: 'package/runtime/node', source: 'package', codex: 'codex', claude: 'claude', autoInstall: 'true' }) + '\n');
  await writeFile(join(resources, 'Distribution.txt'), 'AgentBase for macOS 14 or newer. This build includes Node.js and the AgentBase runtime. It is locally signed but not Apple notarized.\n');
  execFileSync('codesign', ['--force', '--sign', '-', join(bundledPackage, 'runtime', 'node')], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });

  await rm(archivePath, { force: true });
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archivePath], { stdio: 'inherit' });
  const extracted = join(scratch, 'extracted');
  await mkdir(extracted);
  execFileSync('ditto', ['-x', '-k', archivePath, extracted], { stdio: 'inherit' });
  const relocated = join(extracted, 'AgentBase.app');
  execFileSync('codesign', ['--verify', '--deep', '--strict', relocated], { stdio: 'inherit' });
  const snapshot = execFileSync(join(relocated, 'Contents/Resources/package/runtime/node'),
    [join(relocated, 'Contents/Resources/bridge/inspector-main.js'), '--home', join(scratch, 'empty-store')],
    { encoding: 'utf8' });
  if (JSON.parse(snapshot).status !== 'empty') throw new Error('Relocated inspector did not open an empty store.');
  let codex;
  try { codex = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim(); } catch { /* Codex is optional on the build Mac. */ }
  if (codex) {
    const codexHome = join(scratch, 'codex-profile');
    await mkdir(codexHome);
    const node = join(relocated, 'Contents/Resources/package/runtime/node');
    const setup = join(relocated, 'Contents/Resources/bridge/connections-main.js');
    const source = join(relocated, 'Contents/Resources/package');
    for (const action of ['install', 'check']) {
      const reply = JSON.parse(execFileSync(node, [setup, action, '--source', source, '--codex', codex],
        { env: { ...process.env, CODEX_HOME: codexHome }, encoding: 'utf8' }));
      if (!reply.ok || !reply.installed || !reply.enabled || (action === 'check' && (!reply.tool_count || !reply.codex_tool_count))) {
        throw new Error(`Bundled Codex ${action} check failed: ${reply.error ?? reply.message ?? 'unknown error'}`);
      }
    }
  }
  const stage = join(scratch, 'installer-root', 'Applications');
  await mkdir(stage, { recursive: true });
  await cp(app, join(stage, 'AgentBase.app'), { recursive: true });
  await rm(installerPath, { force: true });
  execFileSync('pkgbuild', ['--root', join(scratch, 'installer-root'), '--identifier', 'dev.agentbase.inspector', '--version', manifest.version, '--install-location', '/', installerPath], { stdio: 'inherit' });
  const payload = execFileSync('pkgutil', ['--payload-files', installerPath], { encoding: 'utf8' });
  if (!payload.includes('Applications/AgentBase.app/Contents/MacOS/AgentbaseInspector')) throw new Error('Installer is missing the app.');
  console.log(`Created ${archivePath}\nCreated ${installerPath}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
