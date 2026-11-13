import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, symlink, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../dist/store.js';
import { Agentbase } from '../dist/service.js';
const exec = promisify(execFile);

async function fixture(t, { data = true, clock } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agentbase-recovery-test-'));
  const root = join(directory, 'source-project'), restoredRoot = join(directory, 'restored-project');
  await Promise.all([mkdir(root), mkdir(restoredRoot)]);
  let sourceStore = new Store(join(directory, 'source-state'), clock);
  const service = new Agentbase(sourceStore);
  const project = await service.call('project_open', { root, name: 'Recovery project', goal: 'Recover linked work and data.' });
  const write = (tool, args = {}) => service.call(tool, { project_id: project.id, actor: 'seed', request_id: randomUUID(), ...args });
  const plan = await write('plan_save', { goal: project.goal, milestones: [{ title: 'Recover', acceptance: 'Saved work and data remain usable.' }] });
  const taskInput = { request_id: 'stable-task-write', title: 'Verify restored data', description: 'Continue the data investigation.', acceptance: ['A sum is reproducible.'], plan_id: plan.id };
  let task = await write('task_create', taskInput);
  const dependent = await write('task_create', { title: 'Summarize results', description: 'Depends on data verification.', acceptance: ['Link the verified analysis.'], dependencies: [task.id], plan_id: plan.id });
  task = await write('task_claim', { id: task.id, expected_version: 1 });
  const session = await write('session_start', { client: 'test', task_id: task.id });
  const memory = await write('memory_record', { kind: 'fact', title: 'Recovery sentinel', content: 'The retained project constraint is recoverable.', source: 'Test fixture', epistemic_status: 'observed', related_ids: [task.id] });
  const forgotten = await write('memory_record', { kind: 'fact', title: 'Forget me', content: 'forgotten-private-sentinel', source: 'Test fixture', epistemic_status: 'observed' });
  await write('memory_update', { id: forgotten.id, expected_version: 1, status: 'forgotten', reason: 'Remove test content.' });
  await write('checkpoint_save', { session_id: session.id, task_id: task.id, summary: 'Investigation checkpoint.', next_action: 'Continue with integration checks.', related_ids: [memory.id],
    evidence: [{ kind: 'analysis', reference: 'https://example.invalid/external-analysis', outcome: 'Historical external reference, not a managed dataset.' }],
    task_progress: { expected_version: task.version, summary: 'Inputs recorded.' } });
  let dataset, analysis;
  if (data) {
    await writeFile(join(root, 'input.csv'), 'value\n3\n4\n5\n');
    await write('dataset_import', { name: 'Numbers', path: 'input.csv' });
    dataset = await write('dataset_import', { name: 'Numbers', path: 'input.csv', related_ids: [task.id] });
    analysis = await write('analysis_run', { title: 'Saved sum', dataset_ids: [dataset.id], task_id: task.id, sql: 'SELECT sum(value) AS total FROM d1' });
  }
  let completed = await write('task_create', { title: 'Document baseline', description: 'Keep completed work and its evidence.', acceptance: ['Baseline documented.'], plan_id: plan.id });
  completed = await write('task_claim', { id: completed.id, expected_version: completed.version });
  completed = await write('task_complete', { id: completed.id, expected_version: completed.version, summary: 'Baseline documented before backup.',
    evidence: [{ kind: analysis ? 'analysis' : 'manual', reference: analysis?.id ?? 'fixture-baseline', outcome: 'Baseline verified.' }] });
  const backupPath = join(directory, 'backup');
  const backupInput = { project_id: project.id, actor: 'seed', request_id: 'backup-once', destination: backupPath };
  const backup = await service.call('project_backup', backupInput);
  const targetStore = new Store(join(directory, 'target-state'));
  const target = new Agentbase(targetStore);
  const restoreInput = { backup_path: backupPath, root: restoredRoot, actor: 'recovery-test', request_id: 'restore-once' };
  t.after(async () => { sourceStore?.close(); targetStore.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, root, restoredRoot, source: service, get sourceStore() { return sourceStore; }, project, plan, task, dependent, completed, session, memory, forgotten,
    dataset, analysis, backup, backupPath, backupInput, target, targetStore, restoreInput, write,
    async destroySource() { const home = sourceStore.home; sourceStore.close(); sourceStore = undefined; await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); },
  };
}
async function altered(f, name, change) {
  const path = join(f.directory, name); await cp(f.backupPath, path, { recursive: true });
  const m = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  change(m);
  const raw = JSON.stringify(m, null, 2) + '\n';
  await writeFile(join(path, 'manifest.json'), raw);
  await writeFile(join(path, 'manifest.sha256'), createHash('sha256').update(raw).digest('hex') + '\n');
  return path;
}

test('full backup restores work, immutable data, search and retry receipts after the source is lost', async t => {
  const f = await fixture(t);
  assert.equal(f.backup.dataset_count, 2); assert.equal(f.backup.unique_dataset_files, 1);
  const verified = await f.source.call('backup_verify', { backup_path: f.backupPath }); assert.equal(verified.valid, true);
  assert.doesNotMatch(await readFile(join(f.backupPath, 'manifest.json'), 'utf8'), /forgotten-private-sentinel/);
  await f.destroySource();
  const result = await f.target.call('project_restore', f.restoreInput);
  assert.equal(result.project_id, f.project.id); assert.equal(result.leases_reset, 1);
  const task = await f.target.call('record_get', { project_id: f.project.id, id: f.task.id });
  assert.equal(task.body.status, 'ready'); assert.equal(task.body.owner, undefined); assert.ok(task.version > f.task.version);
  assert.deepEqual((await f.target.call('record_get', { project_id: f.project.id, id: f.dependent.id })).dependencies, [f.task.id]);
  const completed = await f.target.call('record_get', { project_id: f.project.id, id: f.completed.id });
  assert.equal(completed.body.status, 'done'); assert.equal(completed.body.completion.evidence[0].reference, f.analysis.id);
  const context = await f.target.call('context_get', { project_id: f.project.id });
  assert.equal(context.selected_task_id, f.task.id); assert.match(context.content, /Continue with integration checks/);
  const handoff = await f.target.call('handoff_get', { project_id: f.project.id }); assert.equal(handoff.repository_changed, null);
  const found = await f.target.call('search', { project_id: f.project.id, query: 'recoverable' }); assert.equal(found.records[0].id, f.memory.id);
  assert.equal((await f.target.call('search', { project_id: f.project.id, query: 'forgotten-private-sentinel' })).records.length, 0);
  const replay = await f.target.call('task_create', { project_id: f.project.id, actor: 'seed', ...{ request_id: 'stable-task-write', title: 'Verify restored data', description: 'Continue the data investigation.', acceptance: ['A sum is reproducible.'], plan_id: f.plan.id } });
  assert.equal(replay.id, f.task.id); assert.equal((await f.target.call('task_list', { project_id: f.project.id })).total, 3);
  const analysis = await f.target.call('analysis_run', { project_id: f.project.id, actor: 'recovery-test', request_id: randomUUID(), title: 'Reproduced sum', dataset_ids: [f.dataset.id], sql: f.analysis.body.sql });
  assert.deepEqual(analysis.body.rows, f.analysis.body.rows);
  const exported = await f.target.call('artifact_export', { project_id: f.project.id, analysis_id: f.analysis.id, format: 'csv' });
  assert.match(await readFile(exported.path, 'utf8'), /"12"/);
  assert.equal(f.targetStore.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(f.targetStore.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  const manifest = JSON.parse(await readFile(join(f.backupPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.requests.some(r => r.request_id === 'stable-task-write'), true);
});

test('backup retries preserve the original snapshot and never overwrite unrelated directories', async t => {
  const f = await fixture(t, { data: false });
  await f.write('task_create', { title: 'Later task', description: 'Not part of the earlier snapshot.', acceptance: ['Created later.'] });
  const retried = await f.source.call('project_backup', f.backupInput);
  assert.equal(retried.backup_id, f.backup.backup_id); assert.equal(retried.record_count, f.backup.record_count);
  const existing = join(f.directory, 'user-folder'); await mkdir(existing); await writeFile(join(existing, 'keep.txt'), 'keep');
  await assert.rejects(f.source.call('project_backup', { ...f.backupInput, request_id: randomUUID(), destination: existing }));
  assert.equal(await readFile(join(existing, 'keep.txt'), 'utf8'), 'keep');
  await assert.rejects(f.source.call('project_backup', { ...f.backupInput, request_id: randomUUID(), destination: join(f.sourceStore.home, 'unsafe-backup') }), { code: 'BACKUP_DESTINATION' });
  if (process.platform !== 'win32') assert.equal((await stat(join(f.backupPath, 'manifest.json'))).mode & 0o777, 0o600);
});

test('restore is idempotent, refuses conflicts, and preserves unrelated projects', async t => {
  const f = await fixture(t, { data: false });
  const otherRoot = join(f.directory, 'unrelated'); await mkdir(otherRoot);
  const unrelated = await f.target.call('project_open', { root: otherRoot });
  await assert.rejects(f.target.call('project_restore', { ...f.restoreInput, root: otherRoot }), { code: 'RESTORE_CONFLICT' });
  assert.equal(f.targetStore.projects().length, 1);
  const first = await f.target.call('project_restore', f.restoreInput);
  const count = f.targetStore.all(f.project.id).length;
  await rm(f.backupPath, { recursive: true, force: true });
  const retry = await f.target.call('project_restore', f.restoreInput);
  assert.equal(first.backup_id, retry.backup_id); assert.equal(f.targetStore.all(f.project.id).length, count);
  assert.equal(f.targetStore.project(unrelated.id).root.includes('unrelated'), true);
});

test('invalid metadata, references, cycles and paths are rejected before import', async t => {
  const f = await fixture(t);
  const cases = [
    ['future-format', m => { m.format_version = 999; }],
    ['path-traversal', m => { m.files[0].path = '../../outside.csv'; }],
    ['foreign-record', m => { m.records[0].project_id = `project_${randomUUID()}`; }],
    ['missing-reference', m => { m.dependencies[0].depends_on = `task_${randomUUID()}`; }],
    ['dependency-cycle', m => { m.dependencies.push({ task_id: f.task.id, depends_on: f.dependent.id }); }],
    ['unreferenced-file', m => { m.files.push({ ...m.files[0], sha256: 'a'.repeat(64), path: `datasets/${'a'.repeat(64)}.csv` }); }],
    ['bad-provenance', m => { m.records.find(r => r.kind === 'analysis').body.datasets[0].sha256 = 'b'.repeat(64); }],
    ['forgotten-content', m => { m.records.find(r => r.id === f.forgotten.id).body.content = 'resurrected'; }],
  ];
  for (const [name, change] of cases) {
    const path = await altered(f, name, change);
    await assert.rejects(f.target.call('project_restore', { ...f.restoreInput, backup_path: path }), { code: 'BACKUP_INVALID' }, name);
    assert.equal(f.targetStore.projects().length, 0, name);
  }
});

test('metadata and dataset checksums detect corruption, and symlink entries are rejected', async t => {
  const f = await fixture(t);
  const metadata = join(f.directory, 'metadata-corruption'); await cp(f.backupPath, metadata, { recursive: true });
  await writeFile(join(metadata, 'manifest.json'), '{}');
  await assert.rejects(f.target.call('backup_verify', { backup_path: metadata }), { code: 'BACKUP_INTEGRITY' });
  const bytes = join(f.directory, 'data-corruption'); await cp(f.backupPath, bytes, { recursive: true });
  const m = JSON.parse(await readFile(join(bytes, 'manifest.json'), 'utf8'));
  await writeFile(join(bytes, m.files[0].path), 'corrupted');
  await assert.rejects(f.target.call('project_restore', { ...f.restoreInput, backup_path: bytes }), { code: 'BACKUP_INTEGRITY' });
  assert.equal(f.targetStore.projects().length, 0);
  const linked = join(f.directory, 'symlink'); await cp(f.backupPath, linked, { recursive: true });
  await rm(join(linked, m.files[0].path));
  await symlink(join(f.backupPath, m.files[0].path), join(linked, m.files[0].path));
  await assert.rejects(f.target.call('backup_verify', { backup_path: linked }), { code: 'BACKUP_INVALID' });
  const incomplete = join(f.directory, 'partial'); await mkdir(incomplete);
  await assert.rejects(f.target.call('backup_verify', { backup_path: incomplete }), { code: 'BACKUP_INVALID' });
});

test('a database failure rolls back the entire restore and allows a clean retry', async t => {
  const f = await fixture(t);
  f.targetStore.db.exec("CREATE TRIGGER break_restore BEFORE INSERT ON records WHEN NEW.kind='dataset' BEGIN SELECT RAISE(ABORT,'simulated restore failure'); END");
  await assert.rejects(f.target.call('project_restore', f.restoreInput), /simulated restore failure/);
  assert.equal(f.targetStore.projects().length, 0);
  assert.equal(f.targetStore.db.prepare('SELECT count(*) AS n FROM records').get().n, 0);
  assert.equal(f.targetStore.db.prepare('SELECT count(*) AS n FROM search_index').get().n, 0);
  assert.deepEqual(await readdir(join(f.targetStore.home, 'datasets', f.project.id)), []);
  f.targetStore.db.exec('DROP TRIGGER break_restore');
  assert.equal((await f.target.call('project_restore', f.restoreInput)).restored, true);
});

test('restore cannot write through a symlink in its managed destination', async t => {
  const f = await fixture(t, { data: false });
  const outside = join(f.directory, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.targetStore.home, 'datasets'));
  await assert.rejects(f.target.call('project_restore', f.restoreInput), { code: 'RESTORE_PATH' });
  assert.deepEqual(await readdir(outside), []); assert.equal(f.targetStore.projects().length, 0);
  await rm(join(f.targetStore.home, 'datasets')); await mkdir(join(f.targetStore.home, 'datasets'));
  await symlink(outside, join(f.targetStore.home, 'datasets', f.project.id));
  await assert.rejects(f.target.call('project_restore', f.restoreInput), { code: 'RESTORE_PATH' });
  assert.deepEqual(await readdir(outside), []); assert.equal(f.targetStore.projects().length, 0);
});

test('checkpoint ordering is preserved when source timestamps tie', async t => {
  const f = await fixture(t, { data: false, clock: () => Date.UTC(2026, 10, 12) });
  await f.write('checkpoint_save', { session_id: f.session.id, task_id: f.task.id, summary: 'Newest checkpoint.', next_action: 'Use the newest next action.' });
  const second = join(f.directory, 'second-backup');
  await f.source.call('project_backup', { ...f.backupInput, request_id: randomUUID(), destination: second });
  await f.target.call('project_restore', { ...f.restoreInput, backup_path: second });
  const handoff = await f.target.call('handoff_get', { project_id: f.project.id });
  assert.equal(handoff.checkpoint.body.next_action, 'Use the newest next action.');
});

test('CLI verifies and restores a portable bundle', async t => {
  const f = await fixture(t, { data: false });
  const verified = await exec(process.execPath, ['bin/agentbase.mjs', 'verify', f.backupPath, '--home', join(f.directory, 'cli-state')], { cwd: resolve('.') });
  assert.equal(JSON.parse(verified.stdout).valid, true);
  const restored = await exec(process.execPath, ['bin/agentbase.mjs', 'restore', f.backupPath, f.restoredRoot, '--home', join(f.directory, 'cli-state')], { cwd: resolve('.') });
  assert.equal(JSON.parse(restored.stdout).project_id, f.project.id);
});
