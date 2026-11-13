import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installedPlugin } from './lib/plugin-installation.mjs';

const plugin = await installedPlugin();
const manifest = JSON.parse(await readFile(join(plugin.installedPath, 'mcp.json'), 'utf8')).mcpServers.agentbase;
const directory = await mkdtemp(join(tmpdir(), 'agentbase-installed-recovery-'));
const root = join(directory, 'source-project'), targetRoot = join(directory, 'recovered-project');
const sourceHome = join(directory, 'source-state'), targetHome = join(directory, 'target-state'), backupPath = join(directory, 'portable-backup');
const output = resolve('test-results/recovery');
const clients = [], checks = [];
let report;
async function connect(home) {
  const expand = value => value.replaceAll('${PLUGIN_ROOT}', plugin.installedPath);
  const transport = new StdioClientTransport({ command: manifest.command, args: manifest.args.map(expand), cwd: expand(manifest.cwd ?? plugin.installedPath),
    env: { ...getDefaultEnvironment(), AGENTBASE_HOME: home }, stderr: 'pipe' });
  const client = new Client({ name: 'installed-recovery-validation', version: '1.0.0' });
  await client.connect(transport); clients.push(client); return client;
}
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const error = result.structuredContent ?? JSON.parse(result.content[0].text);
    throw Object.assign(new Error(error.message), { code: error.error });
  }
  return result.structuredContent;
}
const passed = (name, detail = {}) => { const check = { name, passed: true, ...detail }; checks.push(check); console.log(JSON.stringify(check)); };
try {
  await Promise.all([mkdir(root), mkdir(targetRoot), mkdir(output, { recursive: true })]);
  const source = await connect(sourceHome);
  const inventory = await source.listTools();
  for (const tool of ['project_backup', 'backup_verify', 'project_restore']) assert.ok(inventory.tools.some(t => t.name === tool));
  passed('Installed MCP exposes the recovery tools', { version: plugin.version });
  const project = await call(source, 'project_open', { root, name: 'Installed recovery demo', goal: 'Recover work and reproduce a saved join from the bundle alone.' });
  const base = { project_id: project.id, actor: 'recovery-validation' };
  const write = (name, args) => call(source, name, { ...base, request_id: randomUUID(), ...args });
  const plan = await write('plan_save', { goal: project.goal, milestones: [{ title: 'Verify recovery', acceptance: 'The saved join still returns 120 after loss of the source.' }] });
  const createInput = { ...base, request_id: 'stable-task', title: 'Verify portable analysis', description: 'Recover this work after the source store is removed.', acceptance: ['Reproduce the saved join and link evidence.'], plan_id: plan.id };
  let task = await call(source, 'task_create', createInput);
  task = await write('task_claim', { id: task.id, expected_version: 1 });
  const session = await write('session_start', { client: 'installed-recovery', task_id: task.id });
  const memory = await write('memory_record', { kind: 'constraint', title: 'Recovery sentinel', content: 'The expected recovered analysis total is 120.', source: 'Synthetic fixture arithmetic', epistemic_status: 'observed', related_ids: [task.id] });
  const forgotten = await write('memory_record', { kind: 'fact', title: 'Disposable note', content: 'discard-this-test-note', source: 'Synthetic fixture', epistemic_status: 'observed' });
  await write('memory_update', { id: forgotten.id, expected_version: 1, status: 'forgotten', reason: 'Test deletion retention.' });
  await writeFile(join(root, 'values.csv'), 'value\n10\n20\n30\n');
  await writeFile(join(root, 'rates.json'), '[{"rate":2}]');
  const values = await write('dataset_import', { name: 'Values', path: 'values.csv' });
  const rates = await write('dataset_import', { name: 'Rates', path: 'rates.json' });
  const sql = 'SELECT sum(v.value * r.rate) AS total FROM d1 v CROSS JOIN d2 r';
  const analysis = await write('analysis_run', { title: 'Saved join', dataset_ids: [values.id, rates.id], task_id: task.id, sql });
  assert.equal(String(analysis.body.rows[0][0]), '120');
  await write('checkpoint_save', { session_id: session.id, task_id: task.id, summary: 'Saved a reproducible join and its inputs.', next_action: 'Restore this project and verify the saved join.', related_ids: [memory.id, analysis.id] });
  passed('Source project contains linked work, memory, datasets and analysis');
  const backupArgs = { ...base, request_id: 'backup-portable', destination: backupPath };
  const backup = await call(source, 'project_backup', backupArgs);
  assert.equal(backup.dataset_count, 2);
  assert.equal((await call(source, 'backup_verify', { backup_path: backupPath })).valid, true);
  passed('Portable bundle verifies every dataset and metadata checksum', { datasets: 2, dataset_bytes: backup.dataset_bytes });
  assert.equal((await call(source, 'project_backup', backupArgs)).backup_id, backup.backup_id);
  passed('Backup retry returns the original snapshot');
  assert.doesNotMatch(await readFile(join(backupPath, 'manifest.json'), 'utf8'), /discard-this-test-note/);
  passed('Forgotten content is absent from the portable metadata');
  await source.close();
  await rm(sourceHome, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  passed('Original store and working files removed before recovery');
  const target = await connect(targetHome);
  const restoreArgs = { backup_path: backupPath, root: targetRoot, actor: 'recovery-agent', request_id: 'restore-portable' };
  const corrupt = join(directory, 'corrupt-backup'); await cp(backupPath, corrupt, { recursive: true });
  const damagedManifest = JSON.parse(await readFile(join(corrupt, 'manifest.json'), 'utf8'));
  await writeFile(join(corrupt, damagedManifest.files[0].path), 'damaged');
  await assert.rejects(call(target, 'project_restore', { ...restoreArgs, backup_path: corrupt }), { code: 'BACKUP_INTEGRITY' });
  assert.equal((await call(target, 'project_list', {})).total, 0);
  passed('Corruption is rejected without partially registering a project');
  const restored = await call(target, 'project_restore', restoreArgs);
  assert.equal(restored.project_id, project.id); assert.equal(restored.leases_reset, 1);
  assert.equal(restored.working_root, await realpath(targetRoot));
  const recoveredTask = await call(target, 'record_get', { project_id: project.id, id: task.id });
  assert.equal(recoveredTask.body.status, 'ready'); assert.equal(recoveredTask.body.owner, undefined);
  passed('Restore preserves IDs and resets abandoned ownership');
  const context = await call(target, 'context_get', { project_id: project.id });
  assert.equal(context.selected_task_id, task.id); assert.match(context.content, /expected recovered analysis total is 120/);
  const handoff = await call(target, 'handoff_get', { project_id: project.id });
  assert.equal(handoff.repository_changed, null);
  assert.equal((await call(target, 'search', { project_id: project.id, query: 'Recovery sentinel' })).records.some(r => r.id === memory.id), true);
  passed('Search and handoff context are recovered and require checkout verification');
  const repeated = await call(target, 'task_create', createInput);
  assert.equal(repeated.id, task.id); assert.equal((await call(target, 'task_list', { project_id: project.id })).total, 1);
  passed('Record-write retry receipts prevent duplicate work after recovery');
  const rerun = await call(target, 'analysis_run', { project_id: project.id, actor: 'recovery-agent', request_id: randomUUID(), title: 'Reproduced join', dataset_ids: [values.id, rates.id], sql });
  assert.deepEqual(rerun.body.rows, analysis.body.rows);
  passed('Saved SQL reproduces the join using recovered CSV and JSON snapshots', { expected_total: 120, actual_total: Number(rerun.body.rows[0][0]) });
  const exported = await call(target, 'artifact_export', { project_id: project.id, analysis_id: analysis.id, format: 'csv' });
  assert.match(await readFile(exported.path, 'utf8'), /"120"/);
  passed('Result exports can be regenerated from the original saved analysis');
  const claim = await call(target, 'task_claim', { project_id: project.id, actor: 'recovery-agent', request_id: randomUUID(), id: task.id, expected_version: recoveredTask.version });
  const done = await call(target, 'task_complete', { project_id: project.id, actor: 'recovery-agent', request_id: randomUUID(), id: task.id, expected_version: claim.version,
    summary: 'Recovered analysis reproduced its expected total.', evidence: [{ kind: 'analysis', reference: rerun.id, outcome: 'The recovered join returns 120.' }] });
  assert.equal(done.body.status, 'done');
  passed('Recovered work can be claimed and completed with new analysis evidence');
  await assert.rejects(call(target, 'project_restore', { ...restoreArgs, request_id: randomUUID() }), { code: 'RESTORE_CONFLICT' });
  assert.equal((await call(target, 'record_get', { project_id: project.id, id: task.id })).body.status, 'done');
  passed('A second restore cannot overwrite the existing project');
  assert.equal((await call(target, 'project_restore', restoreArgs)).backup_id, restored.backup_id);
  passed('Retrying the accepted restore does not import it twice');
  await target.close();
  const restarted = await connect(targetHome);
  assert.equal((await call(restarted, 'record_get', { project_id: project.id, id: task.id })).body.status, 'done');
  passed('Recovered state survives another MCP restart');
  report = { status: 'passed', plugin_version: plugin.version, synthetic_scenario: true, model_calls: 0, checks,
    record_count: backup.record_count, restored_dataset_count: restored.dataset_count,
    scope: 'Agentbase project state and managed datasets; working files and external evidence files are not included.', temporary_store_removed: true };
} catch (error) {
  report = { status: 'failed', plugin_version: plugin.version, synthetic_scenario: true, model_calls: 0, checks, error: error.message, temporary_store_removed: true };
  process.exitCode = 1;
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
  await rm(directory, { recursive: true, force: true });
}
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
