import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installedPlugin, codexJson, PLUGIN_ID } from './lib/plugin-installation.mjs';
import { startHost, waitForMcp } from './lib/codex-host.mjs';
const exec = promisify(execFile);

const installed = process.argv[2] ? { installedPath: await realpath(resolve(process.argv[2])) } : await installedPlugin();
const pluginRoot = installed.installedPath;
const pluginVersion = JSON.parse(await readFile(join(pluginRoot, 'plugin.json'), 'utf8')).version;
const manifest = JSON.parse(await readFile(join(pluginRoot, 'mcp.json'), 'utf8')).mcpServers.agentbase;
const directory = await realpath(await mkdtemp(join(tmpdir(), 'agentbase-battle-')));
const root = join(directory, 'project'), state = join(directory, 'state');
await mkdir(root);
const checks = [], connections = [];
let host;
let report;
const record = (name, detail) => { checks.push({ name, status: 'passed', ...detail }); console.log(JSON.stringify(checks.at(-1))); };
const expand = value => value.replaceAll('${PLUGIN_ROOT}', pluginRoot);
async function connect() {
  const transport = new StdioClientTransport({ command: manifest.command, args: manifest.args.map(expand), cwd: expand(manifest.cwd ?? pluginRoot),
    env: { ...getDefaultEnvironment(), AGENTBASE_HOME: state }, stderr: 'pipe' });
  const client = new Client({ name: 'agentbase-battle', version: '0.2.0' });
  await client.connect(transport);
  const connection = { client, transport }; connections.push(connection); return connection;
}
async function call(connection, tool, args) {
  const result = await connection.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 20000 });
  if (result.isError) {
    const error = result.structuredContent ?? JSON.parse(result.content[0].text);
    throw Object.assign(new Error(error.message), { code: error.error });
  }
  return result.structuredContent;
}
try {
  for (let round = 0; round < 20; round++) {
    const starts = await Promise.all(Array.from({ length: 6 }, () => exec(process.execPath,
      [join(pluginRoot, 'bin/agentbase.mjs'), 'call', 'project_list', '{}', '--home', join(directory, 'cold', String(round))])));
    assert.ok(starts.every(result => JSON.parse(result.stdout).total === 0));
  }
  record('concurrent_cold_starts', { starts: 120, processes_per_new_store: 6, failures: 0 });
  // Six independent installed stdio processes coordinate through one isolated SQLite store.
  const clients = await Promise.all(Array.from({ length: 6 }, connect));
  const main = clients[0];
  const project = await call(main, 'project_open', { root, goal: 'Recover interrupted work without duplicate tasks.' });
  const base = { project_id: project.id, actor: 'battle' };
  const taskInput = i => ({ ...base, request_id: `task-${i}`, title: `Stress task ${i}`, description: 'A bounded installation stress test.', acceptance: ['Persist once across retries.'] });
  const tasks = await Promise.all(Array.from({ length: 120 }, (_, i) => call(clients[i % clients.length], 'task_create', taskInput(i))));
  await Promise.all(Array.from({ length: 120 }, (_, i) => call(clients[(i + 1) % clients.length], 'task_create', taskInput(i))));
  assert.equal((await call(main, 'task_list', { project_id: project.id })).total, 120);
  record('concurrent_writes_and_retries', { processes: clients.length, unique_tasks: tasks.length, duplicate_retries: 120 });
  const claims = await Promise.allSettled(clients.map((client, i) => call(client, 'task_claim', { ...base, actor: `agent-${i}`, request_id: `claim-${i}`, id: tasks[0].id, expected_version: 1 })));
  assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(claims.filter(r => r.status === 'rejected').every(r => ['TASK_OWNED', 'VERSION_CONFLICT'].includes(r.reason.code)));
  const claimed = claims.find(r => r.status === 'fulfilled').value;
  const owner = claimed.body.owner;
  const session = await call(main, 'session_start', { ...base, actor: owner, request_id: 'session', client: 'installed-battle', task_id: claimed.id });
  const memory = await call(main, 'memory_record', { ...base, request_id: 'decision', kind: 'decision', title: 'Keep content hashes', content: 'Use a content hash to identify repeated imports.', source: 'Test specification', epistemic_status: 'user_stated', related_ids: [claimed.id] });
  await call(main, 'checkpoint_save', { ...base, actor: owner, request_id: 'checkpoint', session_id: session.id, task_id: claimed.id, summary: 'Investigation saved before interruption.', next_action: 'Add the duplicate-import check.', related_ids: [memory.id], task_progress: { expected_version: 2, summary: 'Ready to implement.' } });
  record('exclusive_claim_and_checkpoint', { claimants: 6, successful_claims: 1 });
  // Kill the actual server process while requests are in flight, then replay them.
  const interrupted = await connect();
  let firstResponse;
  const first = new Promise(resolve => { firstResponse = resolve; });
  const floodInput = i => ({ ...base, request_id: `interrupted-${i}`, title: `Interrupted write ${i}`, description: 'Kill and replay test.', acceptance: ['No duplicate on recovery.'] });
  const writes = Array.from({ length: 150 }, (_, i) => call(interrupted, 'task_create', floodInput(i)).then(value => { firstResponse(); return value; }));
  const settling = Promise.allSettled(writes);
  await first;
  process.kill(interrupted.transport.pid, 'SIGKILL');
  await settling;
  await interrupted.client.close();
  // Close the remaining processes too, then recover from a cold server start.
  await Promise.all(clients.map(c => c.client.close()));
  const recovered = await connect();
  await Promise.all(Array.from({ length: 150 }, (_, i) => call(recovered, 'task_create', floodInput(i))));
  assert.equal((await call(recovered, 'task_list', { project_id: project.id })).total, 270);
  const context = await call(recovered, 'context_get', { project_id: project.id });
  assert.equal(context.selected_task_id, claimed.id);
  assert.match(context.content, /Add the duplicate-import check/);
  assert.match(context.content, /Use a content hash/);
  const db = new DatabaseSync(join(state, 'agentbase.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0); }
  finally { db.close(); }
  record('sigkill_and_cold_restart', { replayed_requests: 150, total_unique_tasks: 270, database_integrity: 'ok', resumed_task: true });
  await writeFile(join(root, 'data.csv'), 'service,errors\nimports,5\nexports,2\nimports,3\n');
  const dataset = await call(recovered, 'dataset_import', { ...base, request_id: 'data', path: 'data.csv', name: 'errors' });
  await writeFile(join(root, 'data.csv'), 'service,errors\nimports,999\n');
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) => call(recovered, 'analysis_run', { ...base, request_id: `analysis-${i}`, title: 'Immutable sum', dataset_ids: [dataset.id], sql: 'SELECT sum(errors) FROM d1' })));
  assert.ok(results.every(r => String(r.body.rows[0][0]) === '10'));
  await assert.rejects(call(recovered, 'analysis_run', { ...base, request_id: 'denied', title: 'Denied file', dataset_ids: [dataset.id], sql: "SELECT * FROM read_text('/etc/passwd')" }), { code: 'ANALYSIS_FAILED' });
  record('concurrent_sandboxed_analysis', { queries: results.length, original_sum_preserved: '10', arbitrary_file_query_denied: true });

  // Run the installed plugin through Codex's own loader and tool execution path.
  const hostHome = join(directory, 'host-home'), codexHome = join(directory, 'codex');
  await Promise.all([mkdir(hostHome), mkdir(codexHome)]);
  const env = { ...process.env, HOME: hostHome, CODEX_HOME: codexHome, AGENTBASE_HOME: join(directory, 'host-state') };
  await writeFile(join(codexHome, 'config.toml'), '[analytics]\nenabled = false\n');
  await codexJson(['plugin', 'marketplace', 'add', pluginRoot], { env, cwd: root });
  await codexJson(['plugin', 'add', PLUGIN_ID], { env, cwd: root });
  host = await startHost({ cwd: root, env });
  const plugins = await host.request('plugin/list', { cwds: [root] });
  assert.ok(plugins.marketplaces.flatMap(m => m.plugins).some(p => p.id === PLUGIN_ID && p.installed && p.enabled));
  const skills = await host.request('skills/list', { cwds: [root], forceReload: true });
  assert.equal(skills.data.flatMap(d => d.skills).filter(s => s.name.startsWith('agentbase:') && s.enabled).length, 3);
  let thread = await host.request('thread/start', { cwd: root, ephemeral: true, approvalPolicy: 'never' });
  const server = await waitForMcp(host, thread.thread.id);
  assert.equal(Object.keys(server.tools).length, 29);
  assert.equal(server.serverInfo.version, pluginVersion);
  const hostCall = async (tool, args) => {
    const result = await host.request('mcpServer/tool/call', { threadId: thread.thread.id, server: 'agentbase', tool, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent;
  };
  const hostProject = (await hostCall('project_resume', { root })).project;
  let hostTask = await hostCall('task_create', { project_id: hostProject.id, actor: 'host-battle', request_id: 'host-task', title: 'Codex loader recovery', description: 'Exercise the real Codex tool path.', acceptance: ['Survive host restart.'] });
  const hostBase = { project_id: hostProject.id, actor: 'host-battle' };
  hostTask = await hostCall('task_claim', { ...hostBase, request_id: 'host-claim', id: hostTask.id, expected_version: 1 });
  const hostSession = await hostCall('session_start', { ...hostBase, request_id: 'host-session', client: 'codex-app-server', task_id: hostTask.id });
  await writeFile(join(root, 'host.csv'), 'value\n4\n6\n');
  const hostDataset = await hostCall('dataset_import', { ...hostBase, request_id: 'host-data', path: 'host.csv', name: 'Host analysis' });
  const hostAnalysis = await hostCall('analysis_run', { ...hostBase, request_id: 'host-analysis', title: 'Sum through Codex', dataset_ids: [hostDataset.id], task_id: hostTask.id, sql: 'SELECT sum(value) AS total FROM d1' });
  assert.equal(String(hostAnalysis.body.rows[0][0]), '10');
  const hostMemory = await hostCall('memory_record', { ...hostBase, request_id: 'host-memory', kind: 'fact', title: 'Verified sum', content: 'The host analysis sums to ten.', source: hostAnalysis.id, epistemic_status: 'observed', related_ids: [hostTask.id, hostAnalysis.id] });
  await hostCall('checkpoint_save', { ...hostBase, request_id: 'host-checkpoint', session_id: hostSession.id, task_id: hostTask.id, summary: 'Analysis saved through Codex.', next_action: 'Continue after host restart.', related_ids: [hostMemory.id, hostAnalysis.id], task_progress: { expected_version: hostTask.version, summary: 'Evidence ready.' } });
  record('codex_plugin_loader', { version: pluginVersion, tool_count: 29, skills_enabled: 3, analysis_and_checkpoint_executed: true, model_calls: 0 });
  await host.stop('SIGKILL');
  host = await startHost({ cwd: root, env });
  thread = await host.request('thread/start', { cwd: root, ephemeral: true, approvalPolicy: 'never' });
  await waitForMcp(host, thread.thread.id);
  const persisted = await hostCall('record_get', { project_id: hostProject.id, id: hostTask.id });
  assert.equal(persisted.body.title, 'Codex loader recovery');
  const hostContext = await hostCall('project_resume', { root });
  assert.equal(hostContext.project.id, hostProject.id);
  assert.equal(hostContext.selected_task_id, hostTask.id);
  assert.match(hostContext.content, /Continue after host restart/);
  assert.match(hostContext.content, /The host analysis sums to ten/);
  record('codex_host_restart', { recovered_tool_record: true, recovered_handoff_and_evidence: true });
  // Disable, reconnect, and re-enable through Codex's real configuration API.
  await host.request('config/value/write', { keyPath: `plugins."${PLUGIN_ID}".enabled`, value: false, mergeStrategy: 'replace' });
  await host.stop();
  host = await startHost({ cwd: root, env });
  let configured = await host.request('plugin/list', { cwds: [root] });
  assert.ok(configured.marketplaces.flatMap(m => m.plugins).some(p => p.id === PLUGIN_ID && !p.enabled));
  thread = await host.request('thread/start', { cwd: root, ephemeral: true, approvalPolicy: 'never' });
  const disabled = await host.request('mcpServerStatus/list', { threadId: thread.thread.id });
  assert.ok(!disabled.data.some(s => s.name === 'agentbase' && Object.keys(s.tools).length));
  await host.request('config/value/write', { keyPath: `plugins."${PLUGIN_ID}".enabled`, value: true, mergeStrategy: 'replace' });
  await host.stop();
  host = await startHost({ cwd: root, env });
  thread = await host.request('thread/start', { cwd: root, ephemeral: true, approvalPolicy: 'never' });
  await waitForMcp(host, thread.thread.id);
  assert.equal((await hostCall('record_get', { project_id: hostProject.id, id: hostTask.id })).id, hostTask.id);
  const finished = await hostCall('task_complete', { ...hostBase, request_id: 'host-complete', id: hostTask.id, expected_version: persisted.version, summary: 'Recovery verified through Codex.', evidence: [{ kind: 'analysis', reference: hostAnalysis.id, outcome: 'The saved sum remains 10.' }] });
  assert.equal(finished.body.status, 'done');
  record('disable_enable_lifecycle', { tools_unloaded_when_disabled: true, data_survived: true });
  report = { status: 'passed', plugin: pluginRoot, checks, temporary_data_removed: true };
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: error.message, host_diagnostics: host?.diagnostics() ?? null }));
  throw error;
} finally {
  await host?.stop();
  await Promise.allSettled(connections.map(c => c.client.close()));
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify(report));
