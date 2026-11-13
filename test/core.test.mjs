import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agentbase } from '../dist/service.js';
import { Store } from '../dist/store.js';
const exec = promisify(execFile);

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agentbase-test-'));
  const root = join(directory, 'project'); await mkdir(root);
  const home = join(directory, 'state');
  let store = new Store(home, options.clock);
  let service = new Agentbase(store);
  const project = await service.call('project_open', { root, goal: 'Reliable continuation' });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const f = { root, home, directory, project, get store() { return store; }, get service() { return service; },
    call: (tool, args = {}) => service.call(tool, { project_id: project.id, ...args }),
    write: (tool, args = {}) => service.call(tool, { project_id: project.id, actor: 'codex-a', request_id: randomUUID(), ...args }),
    restart() { store.close(); store = new Store(home, options.clock); service = new Agentbase(store); },
  };
  return f;
}
const taskInput = { title: 'Fix import', description: 'Prevent duplicate imports.', acceptance: ['Repeated import creates no duplicate rows.'] };

test('concurrent cold startup handles SQLite initialization contention', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbase-cold-start-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (let round = 0; round < 10; round++) {
    const results = await Promise.all(Array.from({ length: 6 }, () => exec(process.execPath,
      ['bin/agentbase.mjs', 'call', 'project_list', '{}', '--home', join(directory, String(round))], { cwd: resolve('.') })));
    for (const result of results) assert.equal(JSON.parse(result.stdout).total, 0);
  }
});

test('fresh process resumes task, sourced decision, checkpoint and saved plan', async t => {
  const f = await fixture(t);
  const plan = await f.write('plan_save', { goal: 'Reliable imports', milestones: [{ title: 'Idempotent import', acceptance: 'Reimport safely.' }] });
  let task = await f.write('task_create', { ...taskInput, plan_id: plan.id });
  task = await f.write('task_claim', { id: task.id, expected_version: task.version });
  const session = await f.write('session_start', { client: 'codex', task_id: task.id });
  const decision = await f.write('memory_record', { kind: 'decision', title: 'Hash source files', content: 'Deduplicate by file content hash.',
    source: 'User-approved design discussion', epistemic_status: 'user_stated', related_ids: [task.id] });
  const checkpoint = await f.write('checkpoint_save', { session_id: session.id, task_id: task.id, summary: 'Found duplicate path.', next_action: 'Implement content hashing.',
    remaining: ['Add hashing', 'Run import checks'], failed_approaches: ['Filename-only deduplication misses renamed files.'], related_ids: [decision.id],
    task_progress: { expected_version: task.version, summary: 'Investigation complete.' } });
  f.restart();
  const context = await f.call('context_get', { task_id: task.id });
  assert.match(context.content, /Deduplicate by file content hash/);
  assert.match(context.content, /Implement content hashing/);
  assert.match(context.content, /Filename-only/);
  assert.ok(context.chars <= 8000);
  const next = await f.call('record_get', { id: task.id });
  assert.equal(next.body.progress, 'Investigation complete.');
  const { stdout } = await exec(process.execPath, ['bin/agentbase.mjs', 'call', 'handoff_get', JSON.stringify({ project_id: f.project.id, task_id: task.id }), '--home', f.home], { cwd: resolve('.') });
  assert.equal(JSON.parse(stdout).checkpoint.id, checkpoint.id);
});

test('retry is idempotent, changed arguments conflict, versions protect updates', async t => {
  const f = await fixture(t);
  const input = { ...taskInput, request_id: 'create-one' };
  const a = await f.write('task_create', input);
  assert.equal((await f.write('task_create', input)).id, a.id);
  assert.equal(f.store.all(f.project.id, 'task').length, 1);
  await assert.rejects(f.write('task_create', { ...input, title: 'Changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await f.write('task_update', { id: a.id, expected_version: 1, title: 'New title' });
  await assert.rejects(f.write('task_update', { id: a.id, expected_version: 1, title: 'Overwritten' }), { code: 'VERSION_CONFLICT' });
});

test('dependencies reject cycles and rolled-back writes leave no partial task', async t => {
  const f = await fixture(t);
  const a = await f.write('task_create', taskInput);
  const b = await f.write('task_create', { ...taskInput, title: 'Second', dependencies: [a.id] });
  await assert.rejects(f.write('task_update', { id: a.id, expected_version: 1, dependencies: [b.id] }), { code: 'DEPENDENCY_CYCLE' });
  assert.equal((await f.call('task_list', { ready_only: true })).total, 1);
  await assert.rejects(f.write('task_claim', { id: b.id, expected_version: 1 }), { code: 'DEPENDENCIES_OPEN' });
  await assert.rejects(f.write('task_create', { ...taskInput, dependencies: ['missing'] }), { code: 'NOT_FOUND' });
  assert.equal(f.store.all(f.project.id, 'task').length, 2);
});

test('task pages retain priority order, blockers, and expired-lease recovery', async t => {
  let now = Date.now(); const f = await fixture(t,{clock:()=>now});
  const prerequisite = await f.write('task_create',{...taskInput,title:'Prerequisite',priority:0}); now += 1000;
  const blocked = await f.write('task_create',{...taskInput,title:'Blocked',priority:0,dependencies:[prerequisite.id]}); now += 1000;
  const ordinary = await f.write('task_create',{...taskInput,title:'Ordinary',priority:1}); now += 1000;
  let reclaimable = await f.write('task_create',{...taskInput,title:'Reclaimable',priority:0});
  reclaimable = await f.write('task_claim',{id:reclaimable.id,expected_version:reclaimable.version,lease_seconds:30});
  now += 31000;
  const first = await f.call('task_list',{ready_only:true,limit:2,offset:0});
  const second = await f.call('task_list',{ready_only:true,limit:2,offset:2});
  assert.equal(first.total,3); assert.deepEqual(first.records.map(task=>task.id),[prerequisite.id,reclaimable.id]);
  assert.deepEqual(second.records.map(task=>task.id),[ordinary.id]);
  assert.equal(first.records[1].reclaimable,true);
  assert.ok(![...first.records,...second.records].some(task=>task.id===blocked.id));
  assert.deepEqual((await f.call('task_list',{ready_only:true,status:'in_progress'})).records.map(task=>task.id),[reclaimable.id]);
});

test('task context follows explicit graph links in either direction', async t => {
  const f = await fixture(t);
  const outgoing = await f.write('plan_save',{goal:'Outgoing linked plan',milestones:[{title:'One',acceptance:'Done'}]});
  const incoming = await f.write('plan_save',{goal:'Incoming linked plan',milestones:[{title:'Two',acceptance:'Done'}]});
  await f.write('plan_save',{goal:'Newest unrelated plan',milestones:[{title:'Three',acceptance:'Done'}]});
  let task = await f.write('task_create',{...taskInput});
  task = await f.write('graph_link',{source_id:task.id,target_id:outgoing.id,expected_version:task.version});
  await f.write('graph_link',{source_id:incoming.id,target_id:task.id,expected_version:incoming.version});
  const details = await f.call('record_get',{id:task.id});
  assert.ok(details.related_ids.includes(outgoing.id));
  assert.ok(details.related_ids.includes(incoming.id));
  const context = await f.call('context_get',{task_id:task.id});
  assert.match(context.content,/Outgoing linked plan/);
  assert.match(context.content,/Incoming linked plan/);
});

test('multiword retrieval ranks complete matches before partial matches without losing pages', async t => {
  const f = await fixture(t);
  const partial = [];
  for (let i = 0; i < 8; i++) partial.push(await f.write('task_create', {
    ...taskInput, title: `Quartz only ${i}`, description: 'quartz '.repeat(30), status: 'proposed',
  }));
  const complete = await f.write('task_create', {
    ...taskInput, title: 'Nebula quartz', description: 'Both project keywords.', status: 'proposed',
  });
  const first = await f.call('search', { query: 'quartz nebula', kind: 'task', limit: 3 });
  const second = await f.call('search', { query: 'quartz nebula', kind: 'task', limit: 3, offset: 3 });
  assert.equal(first.records[0].id, complete.id);
  assert.deepEqual(new Set([...first.records, ...second.records].map(r => r.id)).size, 6);
  assert.ok([...first.records, ...second.records].some(r => partial.some(p => p.id === r.id)));
  const context = await f.call('context_get', { query: 'quartz nebula', max_chars: 2000 });
  assert.equal(context.included_ids[0], complete.id);
});

test('task reads and resume context explain blockers and reflect completed or reopened prerequisites', async t => {
  const f = await fixture(t);
  let prerequisite = await f.write('task_create', { ...taskInput, title: 'Agree partner schema', requires_evidence: false });
  const dependent = await f.write('task_create', { ...taskInput, title: 'Build schema importer', dependencies: [prerequisite.id] });
  let details = await f.call('record_get', { id: dependent.id });
  assert.deepEqual(details.blockers, [prerequisite.id]);
  assert.deepEqual(details.blocking_tasks, [{ id: prerequisite.id, title: 'Agree partner schema', status: 'ready' }]);
  const context = await f.call('context_get', { task_id: dependent.id });
  assert.match(context.content, /Agree partner schema/);
  assert.ok(context.content.includes(prerequisite.id));
  prerequisite = await f.write('task_claim', { id: prerequisite.id, expected_version: 1 });
  prerequisite = await f.write('task_complete', { id: prerequisite.id, expected_version: prerequisite.version, summary: 'Schema agreed.' });
  details = await f.call('record_get', { id: dependent.id });
  assert.deepEqual(details.blockers, []); assert.deepEqual(details.blocking_tasks, []);
  assert.match((await f.call('context_get', { task_id: dependent.id })).content, /"blockers":\[\]/);
  await f.write('task_update', { id: prerequisite.id, expected_version: prerequisite.version, status: 'ready', reason: 'Partner schema changed.' });
  assert.deepEqual((await f.call('record_get', { id: dependent.id })).blockers, [prerequisite.id]);
});

test('two separate processes cannot both own the same task', async t => {
  const f = await fixture(t);
  const task = await f.write('task_create', taskInput);
  const claim = actor => exec(process.execPath, ['bin/agentbase.mjs', 'call', 'task_claim', JSON.stringify({ project_id: f.project.id,
    actor, request_id: randomUUID(), id: task.id, expected_version: 1 }), '--home', f.home], { cwd: resolve('.') });
  const results = await Promise.allSettled([claim('agent-one'), claim('agent-two')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const current = await f.call('record_get', { id: task.id });
  assert.ok(['agent-one', 'agent-two'].includes(current.body.owner));
  assert.equal(current.version, 2);
});

test('lease expiry recovery, completion evidence and reopening', async t => {
  let now = Date.now();
  const f = await fixture(t, { clock: () => now });
  let task = await f.write('task_create', taskInput);
  task = await f.write('task_claim', { id: task.id, expected_version: 1, lease_seconds: 30 });
  await assert.rejects(f.write('task_claim', { actor: 'other', id: task.id, expected_version: 2 }), { code: 'TASK_OWNED' });
  now += 31000;
  await assert.rejects(f.write('task_complete', { id: task.id, expected_version: 2, summary: 'Done' }), { code: 'LEASE_REQUIRED' });
  task = await f.write('task_claim', { actor: 'other', id: task.id, expected_version: 2 });
  await assert.rejects(f.write('task_complete', { actor: 'other', id: task.id, expected_version: 3, summary: 'Done' }), { code: 'EVIDENCE_REQUIRED' });
  task = await f.write('task_complete', { actor: 'other', id: task.id, expected_version: 3, summary: 'Duplicate prevention added.',
    evidence: [{ kind: 'test', reference: 'npm test', outcome: 'Import integration check passed.' }] });
  assert.equal(task.body.completion.verification, 'agent_reported');
  const reopened = await f.write('task_update', { id: task.id, expected_version: 4, status: 'ready', reason: 'New failing case discovered.' });
  assert.equal(reopened.body.status, 'ready'); assert.equal(reopened.body.completion, undefined);
});

test('checkpoint and progress roll back together when a related record is invalid', async t => {
  const f = await fixture(t);
  const task = await f.write('task_create', taskInput);
  await f.write('task_claim', { id: task.id, expected_version: 1 });
  const session = await f.write('session_start', { client: 'codex' });
  await assert.rejects(f.write('checkpoint_save', { session_id: session.id, task_id: task.id, summary: 'Partial', next_action: 'Continue',
    related_ids: ['missing'], task_progress: { expected_version: 2, summary: 'Should not persist' } }), { code: 'NOT_FOUND' });
  assert.equal((await f.call('record_get', { id: task.id })).version, 2);
  assert.equal(f.store.all(f.project.id, 'checkpoint').length, 0);
});

test('project boundaries apply to records, search, dependencies and evidence', async t => {
  const f = await fixture(t);
  const secondRoot = join(f.directory, 'other'); await mkdir(secondRoot);
  const project = await f.service.call('project_open', { root: secondRoot });
  const memory = await f.service.call('memory_record', { project_id: project.id, actor: 'other', request_id: randomUUID(),
    kind: 'fact', title: 'Secret project', content: 'Unique secret zebra', source: 'fixture', epistemic_status: 'observed' });
  await assert.rejects(f.call('record_get', { id: memory.id }), { code: 'NOT_FOUND' });
  assert.equal((await f.call('search', { query: 'zebra' })).records.length, 0);
  await assert.rejects(f.write('task_create', { ...taskInput, related_ids: [memory.id] }), { code: 'NOT_FOUND' });
});

test('memory supersession and forgetting never resurrect text through search or retries', async t => {
  const f = await fixture(t);
  const input = { request_id: 'memory-once', kind: 'fact', title: 'Obsolete rule', content: 'Unique private pineapple', source: 'fixture', epistemic_status: 'observed' };
  const old = await f.write('memory_record', input);
  const updated = await f.write('memory_record', { ...input, request_id: 'correction', title: 'Updated rule', content: 'Use the new rule', supersedes: old.id });
  const context = await f.call('context_get'); assert.doesNotMatch(context.content, /Unique private pineapple/);
  assert.match(context.content, /Use the new rule/);
  const prior = await f.call('record_get', { id: old.id });
  await f.write('memory_update', { id: old.id, expected_version: prior.version, status: 'forgotten', reason: 'Remove obsolete private data.' });
  assert.equal((await f.call('search', { query: 'pineapple' })).records.length, 0);
  const retry = await f.write('memory_record', input);
  assert.equal(retry.body.status, 'forgotten'); assert.equal(retry.body.content, undefined);
  assert.doesNotMatch(JSON.stringify(await f.call('project_export')), /Unique private pineapple/);
  assert.ok(updated.id);
});

test('context budget omits whole records and offers expansion', async t => {
  const f = await fixture(t);
  await f.write('memory_record', { kind: 'fact', title: 'Large detail', content: 'x'.repeat(5000), source: 'fixture', epistemic_status: 'observed' });
  const context = await f.call('context_get', { max_chars: 1000 });
  assert.ok(context.chars <= 1000); assert.equal(context.omitted_ids.length, 1);
  assert.equal(context.omitted_count, 1); assert.equal(context.omitted_ids_truncated, false);
  assert.equal((await f.call('record_get', { id: context.omitted_ids[0] })).body.content.length, 5000);
});

test('large project context reports omitted totals without returning an unbounded ID list', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 180; i++) await f.write('memory_record', {
    kind: 'fact', title: `Memory ${i}`, content: 'x'.repeat(500), source: 'fixture', epistemic_status: 'observed',
  });
  const context = await f.call('context_get', { max_chars: 1000 });
  assert.equal(context.omitted_count, 180);
  assert.equal(context.omitted_ids.length, 50);
  assert.equal(context.omitted_ids_truncated, true);
  assert.ok(JSON.stringify(context).length < 5000);
  assert.equal((await f.call('record_get', { id: context.omitted_ids[0] })).body.title, 'Memory 179');
  const resumed = await f.service.call('project_resume', { root: f.root, max_chars: 1000 });
  assert.equal(resumed.omitted_count, 180);
  assert.equal(resumed.omitted_ids.length, 50);
});

test('handoff detects changed content in an already dirty tracked file', async t => {
  const f = await fixture(t);
  await exec('git', ['init', f.root]);
  await writeFile(join(f.root, 'file.txt'), 'initial');
  await exec('git', ['-C', f.root, 'add', '.']);
  await exec('git', ['-C', f.root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial']);
  await writeFile(join(f.root, 'file.txt'), 'first edit');
  const session = await f.write('session_start', { client: 'codex' });
  await f.write('checkpoint_save', { session_id: session.id, summary: 'Dirty work', next_action: 'Finish' });
  assert.equal((await f.call('handoff_get')).repository_changed, false);
  await writeFile(join(f.root, 'file.txt'), 'second edit');
  assert.equal((await f.call('handoff_get')).repository_changed, true);
});

test('handoff detects changing untracked content and reports incomplete large snapshots', async t => {
  const f = await fixture(t);
  await exec('git', ['init', f.root]);
  await writeFile(join(f.root, 'notes.txt'), 'first draft');
  const session = await f.write('session_start', { client: 'codex' });
  await f.write('checkpoint_save', { session_id: session.id, summary: 'Draft exists', next_action: 'Continue' });
  assert.equal((await f.call('handoff_get')).repository_changed, false);
  await writeFile(join(f.root, 'notes.txt'), 'second draft');
  assert.equal((await f.call('handoff_get')).repository_changed, true);
  await writeFile(join(f.root, 'large.bin'), Buffer.alloc(3 * 1024 * 1024));
  assert.equal((await f.call('handoff_get')).repository_changed, null);
});
