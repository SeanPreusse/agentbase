import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { Store } from '../dist/store.js';
import { Agentbase } from '../dist/service.js';
import { inspectorSnapshot, ALL_PROJECTS_ID } from '../dist/inspector.js';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agentbase-inspector-')); const home = join(dir, 'state'); const root = join(dir, 'project'); await mkdir(root);
  const store = new Store(home); const service = new Agentbase(store);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const project = await service.call('project_open', { root });
  const write = (tool, args) => service.call(tool, { project_id: project.id, actor: 'test-inspector', request_id: randomUUID(), ...args });
  return { dir, home, store, service, project, write };
}

test('inspector does not initialize missing stores or mutate an existing database', async t => {
  const f = await setup(t); const missing = join(f.dir, 'missing');
  assert.equal(inspectorSnapshot(missing).status, 'empty'); assert.ok(!(await readdir(f.dir)).includes('missing'));
  await f.write('task_create', { title: 'Visible task', description: 'Inspect it', acceptance: ['Visible'] });
  f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before = await readFile(join(f.home, 'agentbase.sqlite'));
  const result = inspectorSnapshot(f.home);
  assert.equal(result.status, 'connected'); assert.equal(result.records[0].body.title, 'Visible task');
  assert.deepEqual(await readFile(join(f.home, 'agentbase.sqlite')), before);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM records').get().n, 1);
});

test('inspector scopes projects, explains dependencies and lease expiry, and omits forgotten text', async t => {
  const f = await setup(t);
  const prereq = await f.write('task_create', { title: 'Prerequisite', description: 'First', acceptance: ['Done'] });
  await f.write('task_create', { title: 'Dependent', description: 'Second', acceptance: ['Done'], dependencies: [prereq.id] });
  const claimed = await f.write('task_claim', { id: prereq.id, expected_version: prereq.version });
  const memory = await f.write('memory_record', { kind: 'fact', title: 'Forget this', content: 'sensitive-old-text', source: 'Test', epistemic_status: 'observed' });
  await f.write('memory_update', { id: memory.id, expected_version: memory.version, status: 'forgotten', reason: 'Test forgetting' });
  const otherRoot = join(f.dir, 'other'); await mkdir(otherRoot); const other = await f.service.call('project_open', { root: otherRoot });
  await f.service.call('task_create', { project_id: other.id, actor: 'other', request_id: randomUUID(), title: 'Other project task', description: 'Private', acceptance: ['Done'] });
  const snapshot = inspectorSnapshot(f.home, f.project.id);
  assert.equal(snapshot.projects.length, 2); assert.equal(snapshot.records.find(r => r.id === prereq.id).lease_active, true);
  assert.equal(snapshot.records.find(r => r.body.title === 'Dependent').dependencies[0].status, 'in_progress');
  assert.equal(snapshot.task_summary.leased, 1); assert.equal(snapshot.task_summary.blocked, 1);
  assert.ok(!JSON.stringify(snapshot).includes('sensitive-old-text')); assert.ok(!snapshot.events.find(e=>e.record_id === memory.id)?.record_title); assert.ok(!JSON.stringify(snapshot.records).includes('Other project task'));
  const body = { ...claimed.body, lease_expires_at: '2000-01-01T00:00:00.000Z' };
  f.store.db.prepare('UPDATE records SET body=? WHERE id=?').run(JSON.stringify(body), prereq.id);
  assert.equal(inspectorSnapshot(f.home, f.project.id).records.find(r => r.id === prereq.id).lease_active, false);
  assert.equal(inspectorSnapshot(f.home, 'missing').status, 'error');
});

test('AgentBase overview includes every project and its tasks while project views stay scoped', async t => {
  const f = await setup(t);
  const first = await f.write('task_create', {title:'First workspace task',description:'First',acceptance:['Visible']});
  const otherRoot = join(f.dir,'other'); await mkdir(otherRoot);
  const other = await f.service.call('project_open',{root:otherRoot});
  const second = await f.service.call('task_create',{project_id:other.id,actor:'test-inspector',request_id:randomUUID(),title:'Second workspace task',description:'Second',acceptance:['Visible']});
  const all = inspectorSnapshot(f.home,ALL_PROJECTS_ID);
  assert.equal(all.selected_project_id,ALL_PROJECTS_ID);
  assert.equal(all.projects.length,2);
  assert.equal(all.counts.task,2);
  assert.deepEqual(new Set(all.records.map(row=>row.id)),new Set([first.id,second.id]));
  assert.equal(all.graph.nodes.filter(node=>node.kind==='project').length,2);
  assert.ok(!all.graph.nodes.some(node=>node.id===ALL_PROJECTS_ID));
  assert.ok(!all.graph.edges.some(edge=>edge.source===ALL_PROJECTS_ID||edge.target===ALL_PROJECTS_ID));
  assert.ok(all.graph.edges.some(edge=>edge.source===other.id&&edge.target===second.id));
  assert.equal(inspectorSnapshot(f.home,f.project.id).records.filter(row=>row.kind==='task').length,1);
});

test('All Projects follows child concepts, linked tasks, and source references', async t => {
  const f = await setup(t);
  const root = await f.write('knowledge_save', {node_type:'concept',title:'Data platform',content:'Project domain',source:'Test',epistemic_status:'observed'});
  const child = await f.write('knowledge_save', {node_type:'concept',title:'ServiceNow ingestion',content:'Pipeline work',source:'Test',epistemic_status:'observed',parent_id:root.id});
  const source = await f.write('knowledge_save', {node_type:'resource',title:'Ingestion design',content:'Design reference',source:'Test',epistemic_status:'observed',uri:'https://example.com/ingestion'});
  const task = await f.write('task_create', {title:'Review ingestion',description:'Check the design',acceptance:['Reviewed'],related_ids:[child.id,source.id]});
  const otherRoot = join(f.dir,'other-linked'); await mkdir(otherRoot);
  const other = await f.service.call('project_open',{root:otherRoot});
  const otherTask = await f.service.call('task_create',{project_id:other.id,actor:'test-inspector',request_id:randomUUID(),title:'Other task',description:'Other work',acceptance:['Done']});
  const all = inspectorSnapshot(f.home,ALL_PROJECTS_ID);
  const has = (from,to,relation) => all.graph.edges.some(edge=>edge.source===from&&edge.target===to&&edge.relation===relation);
  for (const id of [f.project.id,root.id,child.id,source.id,task.id,other.id,otherTask.id]) assert.ok(all.graph.nodes.some(node=>node.id===id),id);
  assert.ok(has(f.project.id,root.id,'contains'));
  assert.ok(has(root.id,child.id,'child'));
  assert.ok(has(task.id,child.id,'related'));
  assert.ok(has(task.id,source.id,'related'));
  assert.ok(!has(f.project.id,task.id,'contains'));
  assert.ok(has(other.id,otherTask.id,'contains'));
  assert.ok(!all.graph.edges.some(edge=>edge.source===other.id&&edge.target===task.id));
});

test('All Projects search finds older saved work across projects beyond visible graph nodes', async t => {
  const f = await setup(t);
  const older = await f.write('task_create',{title:'Unique archive marker',description:'Historical task',acceptance:['Found']});
  f.store.transaction(() => { for (let i=0;i<230;i++) f.store.create(f.project.id,'task',{title:`Recent filler ${i}`,description:'Other work',status:'ready'},'test-inspector'); });
  const otherRoot = join(f.dir,'search-other'); await mkdir(otherRoot);
  const other = await f.service.call('project_open',{root:otherRoot});
  const second = await f.service.call('task_create',{project_id:other.id,actor:'test-inspector',request_id:randomUUID(),title:'Unique archive marker',description:'Other project',acceptance:['Found']});
  const snapshot = inspectorSnapshot(f.home,ALL_PROJECTS_ID,undefined,{search:'Unique archive marker'});
  assert.ok(!snapshot.graph.nodes.some(node=>node.id===older.id));
  assert.equal(snapshot.graph_search.total_matches,2);
  assert.deepEqual(new Set(snapshot.graph_search.nodes.map(node=>node.id)),new Set([older.id,second.id]));
  assert.ok(snapshot.graph_search.nodes.every(node=>node.summary.includes(' · ')));
  const focused = inspectorSnapshot(f.home,ALL_PROJECTS_ID,older.id,{search:'Unique archive marker'});
  assert.ok(focused.graph.nodes.some(node=>node.id===older.id));
  assert.ok(focused.records.some(row=>row.id===older.id));
});

test('live inspector stream observes committed writes and stops cleanly', { timeout: 10000 }, async t => {
  const f = await setup(t);
  const child = spawn(process.execPath, ['dist/inspector-main.js', '--watch', '--home', f.home], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const lines = createInterface({ input: child.stdout }); const snapshots = lines[Symbol.asyncIterator]();
  assert.equal(JSON.parse((await snapshots.next()).value).records.length, 0);
  const task = await f.write('task_create', { title: 'Live update', description: 'Fresh', acceptance: ['Visible'] });
  let found = false, graphFound = false;
  for (let i = 0; i < 4; i++) { const snapshot = JSON.parse((await snapshots.next()).value); if (snapshot.records.some(r => r.id === task.id)) found = true; if (snapshot.graph.nodes.some(n => n.id === task.id)) graphFound = true; if (found && graphFound) break; }
  assert.equal(found, true); assert.equal(graphFound, true, 'a committed write invalidates the live graph cache'); child.kill('SIGTERM'); const [code] = await once(child, 'exit'); assert.equal(code, 0); lines.close();
});

test('live snapshot derivations are reused until the watcher observes a store change', async t => {
  const f = await setup(t); const cache = { revision: 0 };
  const first = inspectorSnapshot(f.home, f.project.id, undefined, { search: 'new cached finding', derivedCache: cache });
  const second = inspectorSnapshot(f.home, f.project.id, undefined, { search: 'new cached finding', derivedCache: cache });
  assert.strictEqual(second.graph, first.graph); assert.strictEqual(second.graph_search, first.graph_search);
  await f.write('memory_record', { kind: 'fact', title: 'New cached finding', content: 'A live result', source: 'Inspector cache test', epistemic_status: 'observed' });
  cache.revision++;
  const refreshed = inspectorSnapshot(f.home, f.project.id, undefined, { search: 'new cached finding', derivedCache: cache });
  assert.notStrictEqual(refreshed.graph, first.graph); assert.notStrictEqual(refreshed.graph_search, first.graph_search);
  assert.equal(refreshed.graph_search.nodes[0].title, 'New cached finding');
  assert.equal(inspectorSnapshot(f.home, f.project.id, undefined, { search: 'new cached finding' }).graph_search.nodes[0].title, 'New cached finding', 'one-shot snapshots remain uncached');
});

test('All Projects reuses its merged graph until the store revision changes', async t => {
  const f = await setup(t); const cache = {revision:0};
  const first = inspectorSnapshot(f.home,ALL_PROJECTS_ID,undefined,{derivedCache:cache});
  const second = inspectorSnapshot(f.home,ALL_PROJECTS_ID,undefined,{derivedCache:cache});
  assert.strictEqual(second.graph,first.graph);
  const task = await f.write('task_create',{title:'Fresh overview task',description:'New work',acceptance:['Visible']});
  cache.revision++;
  const refreshed = inspectorSnapshot(f.home,ALL_PROJECTS_ID,undefined,{derivedCache:cache});
  assert.notStrictEqual(refreshed.graph,first.graph);
  assert.ok(refreshed.graph.nodes.some(node=>node.id===task.id));
});

test('inspector bounds histories per kind and previews analysis rows', async t => {
  const f = await setup(t);
  f.store.transaction(() => {
    for (let i = 0; i < 205; i++) f.store.create(f.project.id, 'task', { title: `Task ${i}`, status: 'ready' }, 'test');
    f.store.create(f.project.id, 'analysis', { title: 'Preview', rows: Array.from({ length: 40 }, (_, i) => [i]), columns: [{ name: 'n' }] }, 'test');
  });
  const snapshot = inspectorSnapshot(f.home, f.project.id);
  assert.equal(snapshot.omitted, 5); assert.equal(snapshot.counts.task, 205);
  assert.equal(snapshot.task_summary.ready, 205);
  assert.equal(snapshot.records.filter(r => r.kind === 'task').length, 200); assert.equal(snapshot.events.length, 100);
  assert.equal(snapshot.records.find(r => r.kind === 'analysis').body.rows.length, 20);
  const analysisID=snapshot.records.find(r=>r.kind==='analysis').id;
  const focusedAnalysis=inspectorSnapshot(f.home,f.project.id,analysisID).records.find(r=>r.id===analysisID);
  assert.equal(focusedAnalysis.body.rows.length,40);assert.equal(focusedAnalysis.body.inspector_rows_omitted,0);
  const expanded = inspectorSnapshot(f.home, f.project.id, undefined, {taskLimit:400});
  assert.equal(expanded.records.filter(r => r.kind === 'task').length, 205);
  assert.equal(expanded.omitted, 0);
  assert.ok(expanded.events.some(e => e.record_title === 'Preview' && e.record_kind === 'analysis'));
  assert.equal(inspectorSnapshot(f.home, f.project.id, undefined, {taskLimit:NaN}).records.filter(r => r.kind === 'task').length, 200);
  assert.equal(inspectorSnapshot(f.home, f.project.id, undefined, {taskLimit:-1}).records.filter(r => r.kind === 'task').length, 200);
  const child = spawn(process.execPath, ['dist/inspector-main.js', '--home', f.home, '--project', f.project.id, '--task-limit', '400']);
  let output=''; child.stdout.on('data', c => output += c); const [code] = await once(child,'exit');
  assert.equal(code,0); assert.equal(JSON.parse(output).records.filter(r => r.kind === 'task').length,205);
  f.store.transaction(() => { for(let i=205;i<1010;i++) f.store.create(f.project.id,'task',{title:`Task ${i}`,status:'ready'},'test'); });
  assert.equal(inspectorSnapshot(f.home,f.project.id,undefined,{taskLimit:999999}).records.filter(r => r.kind === 'task').length,1000);
});

test('focused records load beyond the recent window without crossing project or forgotten boundaries', async t => {
  const f = await setup(t);
  let oldest, linked, forgotten;
  f.store.transaction(() => {
    oldest = f.store.create(f.project.id, 'task', { title: 'Old work', status: 'in_progress', owner: 'older-agent', lease_expires_at: new Date(Date.now() + 3600000).toISOString() }, 'test');
    linked = f.store.create(f.project.id, 'memory', { title: 'Linked fact', status: 'active' }, 'test');
    forgotten = f.store.create(f.project.id, 'memory', { status: 'forgotten', forgotten_at: new Date().toISOString() }, 'test');
    f.store.related(f.project.id, oldest.id, [linked.id, forgotten.id]);
    for (let i = 0; i < 205; i++) f.store.create(f.project.id, 'task', { title: `Recent ${i}`, status: 'ready' }, 'test');
  });
  const focused = inspectorSnapshot(f.home, f.project.id, oldest.id);
  assert.ok(focused.records.some(r => r.id === oldest.id)); assert.equal(focused.omitted, 5);
  assert.deepEqual(focused.related.map(r => r.id), [linked.id]);
  assert.equal(focused.focused_record_id, oldest.id);
  assert.ok(focused.operations.agents.find(a => a.actor === "older-agent").tasks.some(t => t.id === oldest.id));
  const otherRoot = join(f.dir, 'another'); await mkdir(otherRoot);
  const other = await f.service.call('project_open', { root: otherRoot });
  const foreign = inspectorSnapshot(f.home, other.id, oldest.id);
  assert.equal(foreign.records.length, 0); assert.equal(foreign.related.length, 0);
  assert.ok(!inspectorSnapshot(f.home, f.project.id, forgotten.id).records.some(r => r.id === forgotten.id));
  const missingProject = inspectorSnapshot(f.home, 'missing');
  assert.equal(missingProject.status, 'error'); assert.equal(missingProject.projects.length, 2);
});


test('inspector resolves a workspace by the longest registered folder boundary and never silently picks another project',async t=>{
 const f=await setup(t);const child=join(f.project.root,'nested');await mkdir(child);
 const parent=inspectorSnapshot(f.home,undefined,undefined,{workingRoot:child});
 assert.equal(parent.selected_project_id,f.project.id);assert.equal(parent.working_root,f.project.root);
 const nested=await f.service.call('project_open',{root:child,name:'Nested project'});
 const selected=inspectorSnapshot(f.home,undefined,undefined,{workingRoot:child});
 assert.equal(selected.selected_project_id,nested.id);assert.equal(selected.graph.nodes.find(n=>n.kind==='project').title,'nested');
 const sibling=join(f.dir,'project-other');await mkdir(sibling);
 const unknown=inspectorSnapshot(f.home,undefined,undefined,{workingRoot:sibling});
 assert.equal(unknown.status,'error');assert.match(unknown.error,/no registered/);assert.equal(unknown.records.length,0);
 const manual=inspectorSnapshot(f.home,f.project.id,undefined,{workingRoot:child});
 assert.equal(manual.selected_project_id,f.project.id);assert.equal(manual.working_root,f.project.root);
 const checkoutPath=join(f.dir,'linked-checkout');await mkdir(checkoutPath);const checkout=await realpath(checkoutPath);
 f.store.db.prepare('INSERT INTO project_roots VALUES (?,?,?)').run(checkout,f.project.id,new Date().toISOString());
 const worktree=inspectorSnapshot(f.home,undefined,undefined,{workingRoot:checkout});
 assert.equal(worktree.selected_project_id,f.project.id);assert.equal(worktree.graph.root_id,f.project.id);
 assert.equal(worktree.graph.nodes.find(n=>n.kind==='project').title,'linked-checkout');
 assert.equal(worktree.graph.nodes.find(n=>n.kind==='project').uri,checkout);
});

test('project search finds old full-text work beyond graph and record windows, with ranked bounded scoped results and linked focus',async t=>{
 const f=await setup(t);let old,resource;
 f.store.transaction(()=>{
  resource=f.store.create(f.project.id,'memory',{title:'Old evidence file',node_type:'resource',uri:'/tmp/synthetic-evidence',content:'Evidence',status:'active'},'test');
  old=f.store.create(f.project.id,'task',{title:'Archived café query',description:'x'.repeat(1500)+' special_archive_term',status:'done'},'test');
  f.store.related(f.project.id,old.id,[resource.id]);
  for(let i=0;i<10005;i++)f.store.create(f.project.id,'memory',{title:`Background ${i}`,content:'Machinery',graph_role:'background',status:'active'},'test');
 });
 const initial=inspectorSnapshot(f.home,f.project.id);
 assert.ok(!initial.graph.nodes.some(n=>n.id===old.id));assert.ok(!initial.records.some(n=>n.id===resource.id));
 const search=inspectorSnapshot(f.home,f.project.id,undefined,{search:'special_archive_term'});
 assert.deepEqual(search.graph_search.nodes.map(n=>n.id),[old.id]);assert.equal(search.graph_search.total_matches,1);
 assert.ok(!search.graph.nodes.some(n=>n.id===old.id),'Typing does not replace the graph');
 assert.deepEqual(inspectorSnapshot(f.home,f.project.id,undefined,{search:'QUERY CAFE'}).graph_search.nodes.map(n=>n.id),[old.id]);
 const focused=inspectorSnapshot(f.home,f.project.id,old.id);
 assert.ok(focused.records.some(n=>n.id===old.id));assert.ok(focused.graph.nodes.some(n=>n.id===resource.id));
 assert.ok(focused.graph.edges.some(e=>e.source===old.id && e.target===resource.id));
 const background=inspectorSnapshot(f.home,f.project.id,undefined,{search:'Machinery'});
 assert.equal(background.graph_search.total_matches,0);
 const all=inspectorSnapshot(f.home,f.project.id,undefined,{search:'Machinery',includeBackground:true});
 assert.equal(all.graph_search.nodes.length,50);assert.equal(all.graph_search.total_matches,10005);assert.equal(all.graph_search.omitted_matches,9955);
 f.store.transaction(()=>{
  f.store.create(f.project.id,'memory',{title:'Ranked result',content:'Exact title',status:'active'},'test');
  f.store.create(f.project.id,'memory',{title:'Other',content:'Ranked result in body',status:'active'},'test');
  f.store.create(f.project.id,'memory',{title:'Forgotten',content:'Ranked result',status:'forgotten'},'test');
  f.store.create(f.project.id,'analysis',{title:'Saved query',sql:'SELECT analysis_sql_token FROM fixture',rows:[],columns:[]},'test');
 });
 assert.equal(inspectorSnapshot(f.home,f.project.id,undefined,{search:'ranked result'}).graph_search.nodes[0].title,'Ranked result');
 assert.equal(inspectorSnapshot(f.home,f.project.id,undefined,{search:'analysis_sql_token'}).graph_search.nodes[0].title,'Saved query');
 assert.equal(inspectorSnapshot(f.home,f.project.id,undefined,{search:'nothing_matches_here'}).graph_search.total_matches,0);
 const otherRoot=join(f.dir,'other-search');await mkdir(otherRoot);const other=await f.service.call('project_open',{root:otherRoot});
 assert.equal(inspectorSnapshot(f.home,other.id,undefined,{search:'special_archive_term'}).graph_search.total_matches,0);
 const child=spawn(process.execPath,['dist/inspector-main.js','--home',f.home,'--project',f.project.id,'--search','special_archive_term']);
 let output='';child.stdout.on('data',c=>output+=c);const [code]=await once(child,'exit');assert.equal(code,0);assert.equal(JSON.parse(output).graph_search.nodes[0].id,old.id);
});


test('focused chart results remain bounded and disclose both saved and inspector truncation',async t=>{
 const f=await setup(t);const analysis=f.store.create(f.project.id,'analysis',{title:'Synthetic older result',columns:[{name:'n',type:'INTEGER'}],rows:Array.from({length:1005},(_,n)=>[n]),truncated:true},'test');
 const focused=inspectorSnapshot(f.home,f.project.id,analysis.id).records.find(r=>r.id===analysis.id);
 assert.equal(focused.body.rows.length,1000);assert.equal(focused.body.inspector_rows_omitted,5);assert.equal(focused.body.truncated,true);
 assert.equal(f.store.get(f.project.id,analysis.id).body.rows.length,1005,'Inspection never rewrites saved result rows');
});
