import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'darwin') { console.log('Native model checks require macOS.'); process.exit(0); }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'agentbase-native-checks-'));
try {
  const executable = join(scratch, 'InspectorChecks');
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-D', 'INSPECTOR_TESTING', '-framework', 'SwiftUI', '-framework', 'AppKit', join(root, 'native/AgentbaseInspector/AgentbaseInspector.swift'), join(root, 'native/AgentbaseInspector/GraphCanvas.swift'), join(root, 'native/AgentbaseInspector/KanbanWorkspace.swift'), join(root, 'native/AgentbaseInspector/SkillWorkspace.swift'), join(root, 'native/AgentbaseInspector/ConnectionsWorkspace.swift'), join(root, 'native/AgentbaseInspector/AnalysisWorkspace.swift'), join(root, 'native/AgentbaseInspector/InspectorChecks.swift'), '-o', executable], { stdio: 'inherit' });
  execFileSync(executable, [], { stdio: 'inherit' });
} finally { rmSync(scratch, { recursive: true, force: true }); }
