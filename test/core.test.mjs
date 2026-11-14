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

test('task sources validate references, join task context, and stay distinct from dependencies', async t => {
  const f = await fixture(t);
  const skill = await f.write('skill_save', {title:'Review schemas',description:'Check interface boundaries.',source:'file:///skills/review/SKILL.md',triggers:['review schema']});
  const dependency = await f.write('task_create',{title:'Agree schema',description:'Set the input shape.',acceptance:['Schema agreed.'],requires_evidence:false});
  const task = await f.write('task_create',{
    title:'Implement source links',description:'Reference useful context.',acceptance:['Sources are visible.'],dependencies:[dependency.id],
    sources:[
      {kind:'record',reference:skill.id,note:'Used for review guidance.'},
      {kind:'web',reference:'https://example.com/spec',title:'Protocol specification'},
      {kind:'document',reference:'/docs/interface.md'},
      {kind:'file',reference:'/data/sample.json',title:'Sample input'},
    ],requires_evidence:false,
  });
  assert.equal(task.body.sources.length,4);
  const detail = await f.call('record_get',{id:task.id});
  assert.ok(detail.dependencies.includes(dependency.id));
  assert.ok(!task.body.sources.some(source=>source.reference===dependency.id));

  const graph = await f.call('graph_get',{view:'content'});
  assert.ok(graph.edges.some(edge=>edge.source===task.id && edge.target===skill.id && edge.relation==='source'));
  const neighborhood = await f.call('graph_get',{focus_id:skill.id,depth:1});
  assert.ok(neighborhood.nodes.some(node=>node.id===task.id));
  assert.ok(detail.related_ids.includes(skill.id));

  const updated = await f.write('task_update',{id:task.id,expected_version:task.version,sources:[{kind:'record',reference:skill.id,title:'Applied skill'}]});
  assert.equal(updated.body.sources.length,1);
  await assert.rejects(f.write('task_update',{id:task.id,expected_version:updated.version,sources:[{kind:'record',reference:'skill_missing'}]}),{code:'NOT_FOUND'});
  const otherRoot=join(f.directory,'other-source-project'); await mkdir(otherRoot);
  const other=await f.service.call('project_open',{root:otherRoot});
  await assert.rejects(f.service.call('task_create',{project_id:other.id,actor:'codex-a',request_id:randomUUID(),...taskInput,
    sources:[{kind:'record',reference:skill.id}]}),{code:'NOT_FOUND'});

  const dependencyClaim=await f.write('task_claim',{id:dependency.id,expected_version:dependency.version});
  await f.write('task_complete',{id:dependency.id,expected_version:dependencyClaim.version,summary:'Schema agreed.'});
  const claimed=await f.write('task_claim',{id:updated.id,expected_version:updated.version});
  const completed=await f.write('task_complete',{id:updated.id,expected_version:claimed.version,summary:'Sources are retained.',evidence:[{kind:'manual',reference:'task detail review',outcome:'Legacy completion evidence remains available.'}]});
  assert.equal(completed.body.completion.evidence[0].reference,'task detail review');
  assert.equal(completed.body.sources[0].reference,skill.id);
});

test('task hierarchy stays project-scoped, navigable, and complete from leaves upward', async t => {
  const f = await fixture(t);
  const parent = await f.write('task_create', {title:'Ship importer',description:'Deliver the import workflow.',acceptance:['Import works.'],requires_evidence:false});
  const child = await f.write('task_create', {title:'Validate rows',description:'Check imported rows.',acceptance:['Rows validated.'],parent_task_id:parent.id,requires_evidence:false});
  let grandchild = await f.write('task_create', {title:'Check duplicates',description:'Find duplicate rows.',acceptance:['No duplicates.'],parent_task_id:child.id,requires_evidence:false});
  const graph = await f.call('graph_get', {view:'content'});
  assert.ok(graph.edges.some(edge => edge.source===parent.id && edge.target===child.id && edge.relation==='child'));
  assert.ok(graph.edges.some(edge => edge.source===child.id && edge.target===grandchild.id && edge.relation==='child'));
  const neighborhood = await f.call('graph_get',{focus_id:child.id,depth:1});
  assert.ok(neighborhood.nodes.some(node=>node.id===parent.id) && neighborhood.nodes.some(node=>node.id===grandchild.id));
  assert.deepEqual((await f.call('task_list',{parent_task_id:parent.id})).records.map(task=>task.id),[child.id]);
  const detail = await f.call('record_get',{id:child.id});
  assert.equal(detail.parent_task.id,parent.id);
  assert.deepEqual(detail.child_tasks.map(task=>task.id),[grandchild.id]);
  const context = await f.call('context_get',{task_id:child.id});
  assert.ok(context.included_ids.includes(parent.id));
  const resumed = await f.service.call('project_resume',{root:f.root,query:'validate importer rows'});
  assert.equal(resumed.open_tasks.find(task=>task.id===child.id).parent_task_title,'Ship importer');
  assert.equal(resumed.open_tasks.find(task=>task.id===child.id).open_child_count,1);
  assert.deepEqual(resumed.open_tasks.find(task=>task.id===parent.id).open_children,
    [{id:child.id,title:'Validate rows',status:'ready'}]);
  assert.equal(resumed.open_tasks.find(task=>task.id===parent.id).open_children_truncated,false);
  assert.deepEqual(resumed.open_tasks.find(task=>task.id===grandchild.id).open_children,[]);
  const detached = await f.write('task_update',{id:grandchild.id,expected_version:grandchild.version,parent_task_id:null});
  assert.equal(detached.body.parent_task_id,null);
  grandchild = await f.write('task_update',{id:grandchild.id,expected_version:detached.version,parent_task_id:child.id});
  await assert.rejects(f.write('task_update',{id:parent.id,expected_version:parent.version,parent_task_id:grandchild.id}),{code:'TASK_PARENT_CYCLE'});
  await assert.rejects(f.write('task_update',{id:parent.id,expected_version:parent.version,status:'cancelled',reason:'Cancel work.'}),{code:'CHILD_TASKS_OPEN'});
  const otherRoot = join(f.directory,'other-hierarchy'); await mkdir(otherRoot);
  const other = await f.service.call('project_open',{root:otherRoot});
  await assert.rejects(f.service.call('task_create',{project_id:other.id,actor:'codex-a',request_id:randomUUID(),title:'Wrong project',description:'Cross-project child.',acceptance:['Rejected.'],parent_task_id:parent.id}),{code:'NOT_FOUND'});
  const claimedParent = await f.write('task_claim',{id:parent.id,expected_version:parent.version});
  await assert.rejects(f.write('task_complete',{id:parent.id,expected_version:claimedParent.version,summary:'Too soon.'}),{code:'CHILD_TASKS_OPEN'});
  for (const task of [grandchild,child]) {
    const claimed = await f.write('task_claim',{id:task.id,expected_version:task.version});
    await f.write('task_complete',{id:task.id,expected_version:claimed.version,summary:'Verified.'});
  }
  await f.write('task_complete',{id:parent.id,expected_version:claimedParent.version,summary:'All subtasks done.'});
  await assert.rejects(f.write('task_create',{title:'Late subtask',description:'Would reopen completed work.',acceptance:['Rejected.'],parent_task_id:parent.id}),{code:'TASK_PARENT_CLOSED'});
});

test('resume bounds the child preview and signals when more subtasks exist', async t => {
  const f = await fixture(t);
  const parent = await f.write('task_create', {title:'Import pipeline',description:'Implement importing.',acceptance:['Import works.']});
  const children = [];
  for (let index=0; index<6; index++) children.push(await f.write('task_create', {
    title:`Import stage ${index}`,description:'Implement one stage.',acceptance:['Stage works.'],parent_task_id:parent.id,
  }));
  const resumed = await f.service.call('project_resume',{root:f.root,query:'import pipeline'});
  const candidate = resumed.open_tasks.find(task=>task.id===parent.id);
  assert.equal(candidate.open_child_count,6);
  assert.deepEqual(candidate.open_children.map(task=>task.id),children.slice(0,5).map(task=>task.id));
  assert.equal(candidate.open_children_truncated,true);
});

test('project resume ranks compact open task candidates without crossing projects', async t => {
  const f = await fixture(t);
  const match = await f.write('task_create', { title: 'Optimize AI plugin flow', description: 'Reduce project resume calls.', acceptance: ['Resume finds this task.'] });
  let blocked;
  for (let index = 0; index < 13; index++) {
    const task = await f.write('task_create', {
    title: `Unrelated release step ${index}`, description: 'Prepare packaging.', acceptance: ['Package is ready.'], priority: 1,
    });
    if (index === 0) blocked = task;
  }
  blocked = await f.write('task_update', { id: blocked.id, expected_version: blocked.version, status: 'blocked', reason: 'Need the signing team ID from the user.' });
  const resumed = await f.service.call('project_resume', { root: f.root, query: 'optimize AI plugin flow' });
  assert.equal(resumed.open_task_count, 14);
  assert.equal(resumed.open_task_status_counts.blocked, 1);
  assert.equal(resumed.open_task_status_counts.ready, 13);
  assert.equal(resumed.open_tasks.length, 12);
  assert.equal(resumed.open_tasks_truncated, true);
  assert.equal(resumed.open_tasks_scanned, 14);
  assert.equal(resumed.open_tasks[0].id, match.id);
  assert.ok(resumed.open_tasks[0].keyword_score > 0);
  assert.ok(resumed.open_tasks.every(task => task.version > 0 && !('description' in task)));
  assert.equal(resumed.open_tasks.find(task => task.id === blocked.id)?.blocked_reason, 'Need the signing team ID from the user.');
  assert.equal(resumed.blocked_tasks[0].id, blocked.id);
  assert.equal(resumed.blocked_tasks_truncated, false);
  assert.ok(!(await f.call('task_list', { ready_only: true })).records.some(task => task.id === blocked.id));
  await assert.rejects(f.write('task_claim', { id: blocked.id, expected_version: blocked.version }), { code: 'TASK_NOT_READY' });
  const otherRoot = join(f.directory, 'other-project'); await mkdir(otherRoot);
  const other = await f.service.call('project_resume', { root: otherRoot, query: 'optimize AI plugin flow' });
  assert.equal(other.open_task_count, 0);
  assert.deepEqual(other.open_tasks, []);
  assert.deepEqual(other.blocked_tasks, []);
});

test('resume retrieves an older matching task beyond the recent window', async t => {
  const f = await fixture(t);
  const older = await f.write('task_create', {
    title:'Recover historic importer',description:'Repair a long-standing import failure.',acceptance:['Imports work.'],
  });
  for (let index=0; index<205; index++) await f.write('task_create', {
    title:`Unrelated release step ${index}`,description:'Prepare packaging.',acceptance:['Package is ready.'],
  });
  const resumed = await f.service.call('project_resume',{root:f.root,query:'historic importer'});
  assert.equal(resumed.open_task_count,206);
  assert.equal(resumed.open_tasks[0].id,older.id);
  assert.ok(resumed.open_tasks_scanned>200);
  assert.equal(resumed.open_task_search_truncated,false);
  const broad = await f.service.call('project_resume',{root:f.root,query:'unrelated release'});
  assert.equal(broad.open_task_search_truncated,true);
});

test('resume keeps older blocked work visible when matching tasks fill the candidate list', async t => {
  const f = await fixture(t);
  let blocked = await f.write('task_create', {title:'Provide signing information',description:'Wait for user.',acceptance:['Information supplied.']});
  blocked = await f.write('task_update', {id:blocked.id,expected_version:blocked.version,status:'blocked',reason:'Need the Apple team ID.'});
  for (let index=0;index<20;index++) await f.write('task_create', {
    title:`Optimize plugin step ${index}`,description:'Improve flow.',acceptance:['Flow works.'],priority:0,
  });
  const resumed = await f.service.call('project_resume', {root:f.root,query:'optimize plugin flow'});
  assert.equal(resumed.open_task_count,21);
  assert.equal(resumed.open_task_status_counts.blocked,1);
  assert.ok(!resumed.open_tasks.some(task=>task.id===blocked.id));
  assert.deepEqual(resumed.blocked_tasks.map(task=>task.id),[blocked.id]);
  assert.equal(resumed.blocked_tasks[0].blocked_reason,'Need the Apple team ID.');
});

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
