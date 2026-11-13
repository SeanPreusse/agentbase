import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../dist/store.js';
import { Agentbase } from '../dist/service.js';
const exec = promisify(execFile);
const taskInput = { title: 'Continue this investigation', description: 'Preserve unfinished work.', acceptance: ['A fresh session finds the next step.'] };
async function setup(t, clock) {
  const directory = await mkdtemp(join(tmpdir(), 'agentbase-continuity-'));
  const root = join(directory, 'project'); await mkdir(root);
  const home = join(directory, 'state');
  let store = new Store(home, clock), service = new Agentbase(store);
  const project = await service.call('project_open', { root, name: 'Continuity', goal: 'Resume reliably.' });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, root, home, project, get store() { return store; }, get service() { return service; },
    call: (name, args = {}) => service.call(name, { project_id: project.id, ...args }),
    write: (name, args = {}) => service.call(name, { project_id: project.id, actor: 'codex', request_id: randomUUID(), ...args }),
    restart(beforeOpen) { store.close(); beforeOpen?.(); store = new Store(home, clock); service = new Agentbase(store); },
  };
}
async function gitRepo(root) {
  await exec('git', ['init', root]);
  await writeFile(join(root, 'tracked.txt'), 'initial');
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial']);
}

test('default resume recovers the task, task memory, its own plan and next step', async t => {
  const f = await setup(t);
  const plan = await f.write('plan_save', { goal: 'Original investigation plan', milestones: [{ title: 'Diagnose', acceptance: 'Find cause.' }] });
  const task = await f.write('task_create', { ...taskInput, plan_id: plan.id });
  await f.write('task_claim', { id: task.id, expected_version: 1 });
  const session = await f.write('session_start', { client: 'codex' });
  await f.write('memory_record', { kind: 'lesson', scope: 'task', task_id: task.id, title: 'Attempt failed', content: 'The cache is not the source of the issue.', source: 'Reproduction', epistemic_status: 'observed' });
  await f.write('checkpoint_save', { session_id: session.id, task_id: task.id, summary: 'Investigation underway.', next_action: 'Inspect importer retry policy.' });
  await f.write('plan_save', { goal: 'Unrelated newer plan', milestones: [{ title: 'Other work', acceptance: 'Done.' }] });
  f.restart();
  const packet = await f.call('context_get');
  assert.equal(packet.selected_task_id, task.id); assert.equal(packet.selection_reason, 'latest_unfinished_handoff');
  assert.match(packet.content, /Inspect importer retry policy/);
  assert.match(packet.content, /The cache is not the source/);
  assert.match(packet.content, /Original investigation plan/);
  assert.doesNotMatch(packet.content, /Unrelated newer plan/);
});

test('resume does not guess between active tasks and explicit selection wins', async t => {
  const f = await setup(t);
  const a = await f.write('task_create', taskInput), b = await f.write('task_create', { ...taskInput, title: 'Another investigation' });
  await f.write('task_claim', { id: a.id, expected_version: 1 });
  let packet = await f.call('context_get');
  assert.equal(packet.selected_task_id, a.id); assert.equal(packet.selection_reason, 'only_active_task');
  await f.write('task_claim', { id: b.id, expected_version: 1 });
  packet = await f.call('context_get');
  assert.equal(packet.selected_task_id, null); assert.equal(packet.selection_reason, 'multiple_active_tasks');
  assert.match(packet.content, /select a task explicitly/);
  const handoff = await f.call('handoff_get'); assert.equal(handoff.active_tasks.length, 2);
  assert.equal((await f.call('context_get', { task_id: b.id })).selected_task_id, b.id);
});

test('busy handoffs report all active tasks with a bounded preview', async t => {
  const f = await setup(t);
  for (let i = 0; i < 120; i++) f.store.create(f.project.id, 'task', {
    title: `Active task ${i}`, status: 'in_progress', owner: 'fixture',
    lease_expires_at: new Date(Date.now() + 3600000).toISOString(),
  }, 'fixture');
  const handoff = await f.call('handoff_get');
  assert.equal(handoff.selection_reason, 'multiple_active_tasks');
  assert.equal(handoff.active_task_count, 120);
  assert.equal(handoff.active_tasks.length, 50);
  assert.equal(handoff.active_tasks_truncated, true);
  assert.ok(JSON.stringify(handoff).length < 12000);
  const context = await f.call('context_get', { max_chars: 1000 });
  assert.match(context.content, /Active tasks: 120/);
});

test('completed handoffs do not mask active work and expired claims are discoverable', async t => {
  let now = Date.now();
  const f = await setup(t, () => now);
  const old = await f.write('task_create', { ...taskInput, requires_evidence: false });
  await f.write('task_claim', { id: old.id, expected_version: 1 });
  const session = await f.write('session_start', { client: 'codex' });
  await f.write('checkpoint_save', { session_id: session.id, task_id: old.id, summary: 'Old checkpoint', next_action: 'This is finished' });
  await f.write('task_complete', { id: old.id, expected_version: 2, summary: 'Complete' });
  const next = await f.write('task_create', taskInput);
  await f.write('task_claim', { id: next.id, expected_version: 1, lease_seconds: 30 });
  assert.equal((await f.call('context_get')).selected_task_id, next.id);
  assert.equal((await f.call('task_list', { ready_only: true })).total, 0);
  now += 31000;
  const ready = await f.call('task_list', { ready_only: true });
  assert.equal(ready.records[0].id, next.id); assert.equal(ready.records[0].reclaimable, true);
});

test('a registered child workspace detects Git initialized in its parent later', async t => {
  const f = await setup(t);
  await exec('git', ['init', f.directory]);
  const handoff = await f.call('handoff_get');
  assert.equal(handoff.current_repository.available, true);
});

test('Git subdirectories and worktrees share project state, with checkout-specific checkpoints', async t => {
  const f = await setup(t); await gitRepo(f.root);
  // The project existed before Git was initialized, as can happen during setup.
  const primary = await f.service.call('project_open', { root: f.root });
  const checkout = join(f.directory, 'feature');
  await exec('git', ['-C', f.root, 'worktree', 'add', '-b', 'feature', checkout]);
  await mkdir(join(checkout, 'nested'));
  const other = await f.service.call('project_open', { root: join(checkout, 'nested') });
  assert.equal(other.id, primary.id); assert.equal(other.roots.length, 2);
  await writeFile(join(checkout, 'feature-only.csv'), 'value\n42\n');
  const dataset = await f.write('dataset_import', { root: other.working_root, path: 'feature-only.csv', name: 'Feature data' });
  assert.equal(dataset.body.sample[0][0], '42');
  await assert.rejects(f.write('dataset_import', { root: other.working_root, path: join(f.root, 'tracked.txt'), name: 'Other checkout' }), { code: 'PATH_DENIED' });
  const task = await f.write('task_create', taskInput);
  const mainSession = await f.write('session_start', { client: 'codex', root: primary.working_root });
  await f.write('checkpoint_save', { session_id: mainSession.id, task_id: task.id, summary: 'Main checkout work', next_action: 'Main next step' });
  const branchSession = await f.write('session_start', { client: 'codex', root: other.working_root });
  await f.write('checkpoint_save', { session_id: branchSession.id, task_id: task.id, summary: 'Feature checkout work', next_action: 'Feature next step' });
  assert.equal((await f.call('handoff_get', { root: primary.working_root, task_id: task.id })).checkpoint.body.next_action, 'Main next step');
  assert.equal((await f.call('handoff_get', { root: other.working_root, task_id: task.id })).repository_changed, false);
  const packet = await f.call('context_get', { root: other.working_root });
  assert.equal(packet.working_root, other.working_root); assert.match(packet.content, /Feature next step/);
  const listed = await f.service.call('project_list', { query: 'feature' });
  assert.equal(listed.total, 1);
  const stranger = join(f.directory, 'stranger'); await mkdir(stranger);
  await assert.rejects(f.write('session_start', { client: 'codex', root: stranger }), { code: 'ROOT_NOT_REGISTERED' });
});

test('a moved repository can be reattached without losing IDs, and live unrelated repos cannot', async t => {
  const f = await setup(t); await gitRepo(f.root);
  await f.service.call('project_open', { root: f.root });
  const task = await f.write('task_create', taskInput);
  const unrelated = join(f.directory, 'unrelated'); await mkdir(unrelated); await gitRepo(unrelated);
  await assert.rejects(f.write('project_attach', { root: unrelated, reason: 'Wrong repository' }), { code: 'REPOSITORY_MISMATCH' });
  const moved = join(f.directory, 'moved'); await rename(f.root, moved);
  await f.write('project_attach', { root: moved, reason: 'Project folder renamed.' });
  assert.equal((await f.service.call('project_open', { root: moved })).id, f.project.id);
  assert.equal((await f.call('record_get', { id: task.id })).id, task.id);
  assert.match((await f.call('context_get')).working_root, /moved$/);
});

test('version 1 migration preserves records, search, request receipts and original project IDs', async t => {
  const f = await setup(t);
  const task = await f.write('task_create', { ...taskInput, request_id: 'legacy-task' });
  f.restart(() => {
    const db = new DatabaseSync(join(f.home, 'agentbase.sqlite'));
    db.exec("DROP TABLE project_roots; DROP INDEX projects_repository; ALTER TABLE projects DROP COLUMN repository_key; UPDATE meta SET value='1' WHERE key='schema_version';");
    db.close();
  });
  assert.equal(f.store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '2');
  assert.equal((await f.service.call('project_open', { root: f.root })).id, f.project.id);
  assert.equal((await f.write('task_create', { ...taskInput, request_id: 'legacy-task' })).id, task.id);
  assert.equal((await f.call('search', { query: 'investigation' })).records[0].id, task.id);
});

test('unknown database versions are rejected without creating application tables', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbase-future-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'agentbase.sqlite');
  let db = new DatabaseSync(path);
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('schema_version','999');"); db.close();
  assert.throws(() => new Store(directory), { code: 'SCHEMA_VERSION' });
  db = new DatabaseSync(path);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='records'").get(), undefined);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '999'); db.close();
});

test('interrupted migration rolls back schema changes and can be retried without losing state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbase-migration-'));
  const root = join(directory, 'project'); await mkdir(root);
  const home = join(directory, 'state');
  const path = join(home, 'agentbase.sqlite');
  let store = new Store(home);
  const service = new Agentbase(store);
  const project = await service.call('project_open', { root });
  const task = await service.call('task_create', { project_id: project.id, actor: 'test', request_id: 'saved-before-upgrade', ...taskInput });
  store.close();
  t.after(() => rm(directory, { recursive: true, force: true }));
  let db = new DatabaseSync(path);
  db.exec(`DROP TABLE project_roots; DROP INDEX projects_repository; ALTER TABLE projects DROP COLUMN repository_key;
    UPDATE meta SET value='1' WHERE key='schema_version';
    CREATE TRIGGER interrupt_migration BEFORE UPDATE ON meta BEGIN SELECT RAISE(ABORT,'simulated migration interruption'); END;`);
  db.close();
  assert.throws(() => new Store(home), /simulated migration interruption/);
  db = new DatabaseSync(path);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '1');
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_roots'").get(), undefined);
  assert.equal(db.prepare('PRAGMA table_info(projects)').all().some(c => c.name === 'repository_key'), false);
  db.exec('DROP TRIGGER interrupt_migration'); db.close();
  store = new Store(home);
  try {
    assert.equal(store.get(project.id, task.id).body.title, taskInput.title);
    assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '2');
    assert.equal(store.roots(project.id).length, 1);
  } finally { store.close(); }
});

test('doctor tests the packaged interfaces without creating persistent personal state', async () => {
  const { stdout } = await exec(process.execPath, ['bin/agentbase.mjs', 'doctor'], { cwd: resolve('.') });
  const result = JSON.parse(stdout);
  assert.equal(result.core_ok, true); assert.equal(result.analysis_ok, true); assert.equal(result.status, 'passed');
});
