import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID,createHash} from 'node:crypto';
import {Store} from '../dist/store.js';import {Agentbase} from '../dist/service.js';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'agentbase-graph-'));const root=join(dir,'project');await mkdir(root);const s=new Store(join(dir,'state'));const service=new Agentbase(s);const p=await service.call('project_open',{root});t.after(async()=>{s.close();await rm(dir,{recursive:true,force:true})});return{dir,s,service,p,call:(name,input={})=>service.call(name,{project_id:p.id,...input}),write:(name,input={})=>service.call(name,{project_id:p.id,actor:'graph-test',request_id:randomUUID(),...input})}}
const concept=(title,extra={})=>({node_type:'concept',title,content:`Notes about ${title}`,source:'Synthetic graph test',epistemic_status:'observed',...extra});
test('concept hierarchy, typed resources, wiki links and backlink traversal survive reopening',async t=>{const f=await fixture(t);const a=await f.write('knowledge_save',concept('Imports'));const b=await f.write('knowledge_save',concept('Deduplication',{parent_id:a.id,content:'Uses [[Imports|import pipeline]].'}));const r=await f.write('knowledge_save',concept('Design reference',{node_type:'resource',uri:'https://example.com/design'}));await f.write('graph_link',{source_id:b.id,target_id:r.id,expected_version:b.version,relation:'resource'});const task=await f.write('task_create',{title:'Implement hashing',description:'Follow [[Deduplication]].',acceptance:['Hash is stable.'],related_ids:[b.id]});let g=await f.call('graph_get',{focus_id:b.id,depth:1});assert.ok(g.edges.some(e=>e.source===a.id&&e.target===b.id&&e.relation==='child'));assert.ok(g.edges.some(e=>e.target===a.id&&e.relation==='wiki'));assert.ok(g.edges.some(e=>e.target===r.id&&e.relation==='resource'));assert.ok(g.backlinks.some(e=>e.source===task.id));assert.ok(g.nodes.find(n=>n.id===r.id).uri);const restarted=new Store(f.s.home);try{const api=new Agentbase(restarted);g=await api.call('graph_get',{project_id:f.p.id,query:'Deduplication',depth:1});assert.ok(g.matches.includes(b.id));assert.ok(g.nodes.some(n=>n.id===r.id));}finally{restarted.close()}});
test('hierarchy cycles, cross-project links, stale versions, task ownership and idempotency are enforced',async t=>{const f=await fixture(t);const a=await f.write('knowledge_save',concept('Parent'));const b=await f.write('knowledge_save',concept('Child',{parent_id:a.id}));await assert.rejects(f.write('knowledge_save',concept('Parent',{id:a.id,expected_version:a.version,parent_id:b.id})),/cycle/);await assert.rejects(f.write('knowledge_save',concept('Parent',{id:a.id,expected_version:a.version,node_type:'resource',uri:'/tmp/a'})),/Detach child/);const before=f.s.get(f.p.id,a.id).version;const input={source_id:a.id,target_id:b.id,expected_version:before,request_id:'same-link'};const x=await f.write('graph_link',input);const retry=await f.write('graph_link',input);assert.equal(x.version,retry.version);await assert.rejects(f.write('graph_link',{source_id:a.id,target_id:b.id,expected_version:before}),/changed/);const otherRoot=join(f.dir,'other');await mkdir(otherRoot);const other=await f.service.call('project_open',{root:otherRoot});await assert.rejects(f.service.call('graph_get',{project_id:other.id,focus_id:a.id}),/not found/);const task=await f.write('task_create',{title:'Owned',description:'Work',acceptance:['Done']});const owned=await f.write('task_claim',{id:task.id,expected_version:1});await assert.rejects(f.write('graph_link',{source_id:task.id,target_id:a.id,expected_version:owned.version,actor:'different'}),/Another actor/);});
test('ambiguous wiki titles remain unresolved; forgotten nodes disappear from links and search',async t=>{const f=await fixture(t);const a=await f.write('knowledge_save',concept('Same'));await f.write('knowledge_save',concept('Same'));const source=await f.write('knowledge_save',concept('Source',{content:'[[Same]] and [[Missing]].'}));let g=await f.call('graph_get',{});assert.equal(g.unresolved.length,2);assert.ok(g.unresolved.some(v=>v.reason==='ambiguous'));await f.write('memory_update',{id:a.id,expected_version:a.version,status:'forgotten',reason:'Remove fixture'});g=await f.call('graph_get',{focus_id:source.id});assert.ok(!g.nodes.some(n=>n.id===a.id));assert.ok(g.edges.some(e=>e.relation==='wiki'));await assert.rejects(f.call('graph_get',{focus_id:a.id}),/unavailable/);});
test('keyword search covers full content and graph expansion obeys depth and limits',async t=>{const f=await fixture(t);let parent;const ids=[];for(let i=0;i<5;i++){const n=await f.write('knowledge_save',concept(`Concept ${i}`,{parent_id:parent,content:i===0?'x'.repeat(1500)+' unique_keyword':'Next concept'}));ids.push(n.id);parent=n.id;}const search=await f.call('graph_get',{query:'unique_keyword',depth:0});assert.deepEqual(search.matches,[ids[0]]);assert.equal(search.nodes.length,1);assert.equal((await f.call('graph_get',{focus_id:ids[0],depth:1})).nodes.length,2);assert.equal((await f.call('graph_get',{focus_id:ids[0],depth:3,limit:2})).nodes.length,2);});
test('backup restores concepts and links; a tampered hierarchy cycle is rejected before import',async t=>{const f=await fixture(t);const a=await f.write('knowledge_save',concept('Backup parent'));const b=await f.write('knowledge_save',concept('Backup child',{parent_id:a.id}));await f.write('graph_link',{source_id:a.id,target_id:b.id,expected_version:a.version});const dest=join(f.dir,'backup');await f.write('project_backup',{destination:dest});const targetRoot=join(f.dir,'restore');await mkdir(targetRoot);const target=new Store(join(f.dir,'target'));t.after(()=>target.close());const api=new Agentbase(target);await api.call('project_restore',{root:targetRoot,backup_path:dest,actor:'test',request_id:'restore'});assert.ok((await api.call('graph_get',{project_id:f.p.id,focus_id:a.id})).edges.some(e=>e.relation==='child'));const manifest=JSON.parse(await readFile(join(dest,'manifest.json'),'utf8'));manifest.records.find(r=>r.id===a.id).body.parent_id=b.id;const bytes=Buffer.from(JSON.stringify(manifest));await writeFile(join(dest,'manifest.json'),bytes);await writeFile(join(dest,'manifest.sha256'),createHash('sha256').update(bytes).digest('hex'));await assert.rejects(f.service.call('backup_verify',{backup_path:dest}),/cycle/);});

test('content view shows generated information and supporting tasks, while background records remain searchable',async t=>{
 const f=await fixture(t);
 const background=await f.write('knowledge_save',concept('Knowledge graph',{graph_role:'background'}));
 const finding=await f.write('memory_record',{kind:'fact',title:'Recovered query returned 120',content:'Synthetic recovery analysis reproduced the expected value.',source:'Recovery test report',epistemic_status:'observed'});
 const archived=f.s.create(f.p.id,'task',{title:'Supporting finished task',status:'done'},'test');
 const unrelated=f.s.create(f.p.id,'task',{title:'Old administrative task',status:'done'},'test');
 f.s.related(f.p.id,finding.id,[archived.id]);
 const session=await f.write('session_start',{client:'test'});
 const checkpoint=await f.write('checkpoint_save',{session_id:session.id,summary:'Routine handoff',next_action:'Continue'});
 const current=await f.call('graph_get',{view:'content'});const ids=current.nodes.map(n=>n.id);
 assert.ok(ids.includes(finding.id));assert.ok(ids.includes(archived.id));
 for(const id of [background.id,unrelated.id,session.id,checkpoint.id])assert.ok(!ids.includes(id));
 assert.ok((await f.call('graph_get',{})).nodes.some(n=>n.id===background.id));
 assert.ok((await f.call('search',{query:'Knowledge graph'})).records.some(n=>n.id===background.id));
 const updated=await f.write('memory_update',{id:finding.id,expected_version:finding.version,status:'active',graph_role:'background',reason:'Background classification only.'});
 assert.equal(updated.body.content,finding.body.content);
 assert.ok(!(await f.call('graph_get',{view:'content'})).nodes.some(n=>n.id===finding.id));
 assert.ok(!(await f.call('graph_get',{view:'content'})).nodes.some(n=>n.id===archived.id));
});


test('derived folder root anchors graph clusters without making shared membership semantic evidence',async t=>{
 const f=await fixture(t);
 const empty=await f.call('graph_get');
 assert.deepEqual(empty.nodes.map(n=>n.id),[f.p.id]); assert.equal(empty.root_id,f.p.id);
 assert.equal(empty.nodes[0].title,'project'); assert.equal(empty.nodes[0].uri,f.p.root);
 const a=await f.write('knowledge_save',concept('First cluster'));
 const b=await f.write('knowledge_save',concept('Child',{parent_id:a.id}));
 const c=await f.write('knowledge_save',concept('Separate cluster'));
 const full=await f.call('graph_get',{view:'content'});
 assert.equal(full.nodes.filter(n=>n.kind==='project').length,1);
 assert.equal(full.edges.filter(e=>e.relation==='contains').length,2);
 assert.ok(full.edges.some(e=>e.source===a.id && e.target===b.id && e.relation==='child'));
 const local=await f.call('graph_get',{focus_id:a.id,depth:3});
 assert.ok(!local.nodes.some(n=>n.id===c.id)); assert.ok(!local.nodes.some(n=>n.id===f.p.id));
 const search=await f.call('graph_get',{query:'First cluster',depth:3});
 assert.ok(!search.nodes.some(n=>n.id===c.id));
 const root=await f.call('graph_get',{focus_id:f.p.id,depth:2});
 assert.ok(root.nodes.some(n=>n.id===c.id)); assert.ok(root.nodes.some(n=>n.id===b.id));
 assert.equal((await f.call('graph_get',{limit:1})).nodes[0].id,f.p.id);
 const bounded=await f.call('graph_get',{limit:2});assert.equal(bounded.nodes.length,2);assert.equal(bounded.edges.length,1);assert.equal(bounded.edges[0].relation,'contains');
 assert.equal(f.s.db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='project'").get().n,0);
});
