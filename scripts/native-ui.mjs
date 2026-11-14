import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('The native inspector currently supports macOS 14+. The MCP remains cross-platform.');
const destination = join(root, 'build', 'Agentbase Inspector.app');
const contents = join(destination, 'Contents');
const resources = join(contents, 'Resources');
if (existsSync(join(root, 'src'))) execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
await mkdir(join(contents, 'MacOS'), { recursive: true });
await mkdir(join(resources, 'bridge'), { recursive: true });
await cp(join(root, 'assets', 'logo.png'), join(resources, 'AgentBaseLogo.png'));
for (const file of ['inspector-main.js', 'inspector.js', 'operations.js', 'graph.js', 'skills.js', 'version.js', 'connections.js', 'connections-main.js']) await cp(join(root, 'dist', file), join(resources, 'bridge', file));
await writeFile(join(resources, 'bridge', 'package.json'), '{"type":"module"}\n');
const iconTemporary = await mkdtemp(join(tmpdir(), 'agentbase-icon-'));
const iconset = join(iconTemporary, 'AgentBase.iconset');
try {
  await mkdir(iconset);
  for (const [name, size] of [['icon_16x16.png', 16], ['icon_16x16@2x.png', 32], ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64], ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256], ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512], ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024]]) {
    execFileSync('sips', ['-z', String(size), String(size), join(root, 'assets/app-icon.png'), '--out', join(iconset, name)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', '-o', join(resources, 'AgentBase.icns'), iconset], { stdio: 'inherit' });
} finally { await rm(iconTemporary, { recursive: true, force: true }); }
let codex='codex';try{codex=execFileSync('which',['codex'],{encoding:'utf8'}).trim();}catch{}
let claude='claude';try{claude=execFileSync('which',['claude'],{encoding:'utf8'}).trim();}catch{}
await writeFile(join(resources, 'runtime.json'), JSON.stringify({ node: process.execPath, source: root, codex, claude }));
const { version } = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>AgentBase</string>
<key>CFBundleDisplayName</key><string>AgentBase</string>
<key>CFBundleIdentifier</key><string>dev.agentbase.inspector</string>
<key>CFBundleExecutable</key><string>AgentbaseInspector</string>
<key>CFBundleIconFile</key><string>AgentBase.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`, '-O', '-framework', 'SwiftUI', '-framework', 'AppKit', '-framework', 'Security', join(root, 'native/AgentbaseInspector/AgentbaseInspector.swift'), join(root, 'native/AgentbaseInspector/GraphCanvas.swift'), join(root, 'native/AgentbaseInspector/KanbanWorkspace.swift'), join(root, 'native/AgentbaseInspector/MemoryWorkspace.swift'), join(root, 'native/AgentbaseInspector/SkillWorkspace.swift'), join(root, 'native/AgentbaseInspector/ConnectionsWorkspace.swift'), join(root, 'native/AgentbaseInspector/BringYourOwnAI.swift'), join(root, 'native/AgentbaseInspector/AnalysisWorkspace.swift'), '-o', join(contents, 'MacOS/AgentbaseInspector')], { cwd: root, stdio: 'inherit' });
execFileSync('codesign', ['--force', '--deep', '--sign', '-', destination], { stdio: 'inherit' });
console.log(`Built ${destination}`);
if (process.argv.includes('--open')) {
  const homeIndex = process.argv.indexOf('--home');
  const rootIndex = process.argv.indexOf('--root');
  execFileSync('open', ['-a', destination, '--args', ...(rootIndex >= 0 ? ['--root', resolve(process.argv[rootIndex + 1])] : []), ...(homeIndex >= 0 ? ['--home', resolve(process.argv[homeIndex + 1])] : [])]);
}
