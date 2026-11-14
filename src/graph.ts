import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { RecordData } from './store.js';
export interface GraphNode { id: string; kind: string; title: string; summary: string; status: string; uri?: string; degree: number; }
export interface GraphEdge { source: string; target: string; relation: string; }
export interface GraphOptions { query?: string; focus_id?: string; include_id?: string; priority_ids?: string[]; view?: 'all' | 'content'; depth?: number; limit?: number; workingRoot?: string; }
// One folder edge per visible connected component, preferring information over its evidence.
function projectRepresentatives(nodes: Map<string,GraphNode>, edges: GraphEdge[]): string[] {
    const semantic = new Map<string, Set<string>>();
    const childTargets = new Set(edges.filter(edge => edge.relation === 'child').map(edge => edge.target));
    for (const e of edges) for (const [a,b] of [[e.source,e.target],[e.target,e.source]]) {
      const adjacent = semantic.get(a!) ?? new Set<string>(); adjacent.add(b!); semantic.set(a!,adjacent);
    }
    const visited = new Set<string>();
    const rank = (n: GraphNode) => ['concept','memory','decision','analysis','plan','dataset','resource','task','checkpoint','session'].indexOf(n.kind);
    const representatives: string[] = [];
    for (const id of nodes.keys()) {
      if (visited.has(id)) continue;
      const component: string[] = [id]; visited.add(id);
      for (let i=0;i<component.length;i++) for (const next of semantic.get(component[i]!) ?? []) if (!visited.has(next)) {visited.add(next);component.push(next);}
      component.sort((a,b) => rank(nodes.get(a)!) - rank(nodes.get(b)!) || Number(childTargets.has(a)) - Number(childTargets.has(b)) || (semantic.get(b)?.size ?? 0) - (semantic.get(a)?.size ?? 0) || a.localeCompare(b));
      representatives.push(component[0]!);
    }
    return representatives;
}
export function projectGraph(db: DatabaseSync, projectId: string, options: GraphOptions = {}) {
  const limit = options.limit ?? 350, depth = options.depth ?? 1;
  const rows = db.prepare("SELECT * FROM records WHERE project_id=? AND COALESCE(json_extract(body,'$.status'),'')!='forgotten' ORDER BY updated_at DESC,rowid DESC LIMIT 10000").all(projectId);
  let records = rows.map(row => ({ ...row, body: JSON.parse(String(row.body)) })) as unknown as RecordData[];
  const wanted = options.focus_id ?? options.include_id;
  if (wanted && !records.some(r => r.id === wanted)) {
    const row = db.prepare("SELECT * FROM records WHERE project_id=? AND id=? AND COALESCE(json_extract(body,'$.status'),'')!='forgotten'").get(projectId,wanted);
    if (row) { if (records.length === 10000) records.pop(); records.unshift({ ...row, body: JSON.parse(String(row.body)) } as unknown as RecordData); }
  }
  const neighborIDs = new Set<string>();
  if (wanted && wanted !== projectId) {
    const focus=records.find(r=>r.id===wanted);
    if(focus) {
      const b=focus.body;
      for(const key of ['parent_id','parent_task_id','task_id','plan_id','session_id','previous_version_id','supersedes']) if(typeof b[key]==='string') neighborIDs.add(b[key]);
      for(const source of b.sources ?? []) if(source.kind==='record' && typeof source.reference==='string') neighborIDs.add(source.reference);
      for(const link of b.graph_links ?? []) neighborIDs.add(link.target_id);
      for(const id of b.related_ids ?? []) neighborIDs.add(id);
      for(const ds of b.datasets ?? []) neighborIDs.add(ds.id);
    }
    for(const row of db.prepare(`SELECT r.* FROM records r WHERE r.project_id=? AND COALESCE(json_extract(r.body,'$.status'),'')!='forgotten' AND (
      r.id IN (SELECT CASE WHEN source_id=? THEN target_id ELSE source_id END FROM links WHERE source_id=? OR target_id=?) OR
      r.id IN (SELECT CASE WHEN task_id=? THEN depends_on ELSE task_id END FROM dependencies WHERE task_id=? OR depends_on=?) OR
      json_extract(r.body,'$.parent_id')=? OR json_extract(r.body,'$.parent_task_id')=? OR json_extract(r.body,'$.task_id')=? OR json_extract(r.body,'$.plan_id')=? OR
      EXISTS(SELECT 1 FROM json_each(r.body,'$.sources') source WHERE json_extract(source.value,'$.kind')='record' AND json_extract(source.value,'$.reference')=?) OR
      EXISTS(SELECT 1 FROM json_each(r.body,'$.graph_links') j WHERE json_extract(j.value,'$.target_id')=?)) ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 80`).all(projectId,wanted,wanted,wanted,wanted,wanted,wanted,wanted,wanted,wanted,wanted,wanted,wanted)) {
      neighborIDs.add(String(row.id));
    }
    const present=new Set(records.map(r=>r.id));
    for(const id of [...neighborIDs].slice(0,100)) if(!present.has(id)) {
      const row=db.prepare("SELECT * FROM records WHERE project_id=? AND id=? AND COALESCE(json_extract(body,'$.status'),'')!='forgotten'").get(projectId,id);
      if(row) records.push({...row,body:JSON.parse(String(row.body))} as unknown as RecordData);
    }
  }
  if (options.view === 'content') {
    records = records.filter(r => r.body.graph_role !== 'background' && !['session','checkpoint'].includes(r.kind) && !['superseded','stale','rejected'].includes(r.body.status));
  }
  const nodes = new Map<string, GraphNode>(); const titles = new Map<string, string[]>();
  const searchable = new Map<string, string>();
  const edges: GraphEdge[] = []; const seen = new Set<string>();
  const unresolved: { source: string; label: string; reason: string }[] = [];
  for (const r of records) {
    const b = r.body, title = b.title ?? b.name ?? b.goal ?? b.summary ?? b.actor ?? r.kind;
    nodes.set(r.id, { id: r.id, kind: b.node_type ?? r.kind, title: String(title).slice(0,500), summary: String(b.content ?? b.description ?? b.summary ?? b.goal ?? '').slice(0,1000), status: b.status ?? '', ...(b.uri ? { uri: b.uri } : {}), degree: 0 });
    searchable.set(r.id, [title,b.content,b.description,b.summary,b.goal,b.source,b.uri].filter(v => typeof v === 'string').join(' ').toLocaleLowerCase());
    const key = String(title).trim().toLocaleLowerCase(); titles.set(key, [...(titles.get(key) ?? []), r.id]);
  }
  const add = (source: string, target: string, relation: string) => {
    const key = `${source}:${target}:${relation}`;
    if (source === target || !nodes.has(source) || !nodes.has(target) || seen.has(key)) return;
    edges.push({ source, target, relation }); seen.add(key);
  };
  for (const link of db.prepare('SELECT l.* FROM links l JOIN records r ON r.id=l.source_id WHERE r.project_id=?').all(projectId)) add(String(link.source_id), String(link.target_id), 'related');
  for (const link of db.prepare('SELECT d.* FROM dependencies d JOIN records r ON r.id=d.task_id WHERE r.project_id=?').all(projectId)) add(String(link.task_id), String(link.depends_on), 'depends_on');
  for (const r of records) {
    const b = r.body;
    if (b.parent_id) add(b.parent_id, r.id, 'child');
    if (r.kind === 'task' && b.parent_task_id) add(b.parent_task_id, r.id, 'child');
    if (r.kind === 'task') for (const source of b.sources ?? []) if (source.kind === 'record' && typeof source.reference === 'string') add(r.id, source.reference, 'source');
    for (const key of ['task_id', 'plan_id', 'session_id', 'previous_version_id', 'supersedes']) if (b[key]) add(r.id, b[key], key.replace('_id',''));
    for (const link of b.graph_links ?? []) add(r.id, link.target_id, link.relation);
    for (const key of b.related_ids ?? []) add(r.id, key, 'related');
    for (const ds of b.datasets ?? []) add(r.id, ds.id, 'dataset');
    for (const e of b.completion?.evidence ?? b.evidence ?? []) if (e.kind === 'analysis') add(r.id, e.reference, 'source');
    const content = [b.content, b.description, b.summary, b.goal].filter(v => typeof v === 'string').join('\n');
    for (const match of content.matchAll(/\[\[([^\]\n]{1,500})\]\]/g)) {
      const label = match[1]!.split('|')[0]!.split('#')[0]!.trim();
      const targets = nodes.has(label) ? [label] : titles.get(label.toLocaleLowerCase()) ?? [];
      if (targets.length === 1) add(r.id, targets[0]!, 'wiki');
      else if (unresolved.length < 100) unresolved.push({ source: r.id, label, reason: targets.length ? 'ambiguous' : 'missing' });
    }
  }
  if (options.view === 'content') {
    const supported = new Set<string>();
    for (const e of edges) {
      if (nodes.get(e.source)?.kind === 'task' && nodes.get(e.target)?.kind !== 'task') supported.add(e.source);
      if (nodes.get(e.target)?.kind === 'task' && nodes.get(e.source)?.kind !== 'task') supported.add(e.target);
    }
    for (const r of records) if (r.kind === 'task' && ['done','cancelled'].includes(r.body.status) && !supported.has(r.id) && r.id !== wanted && !neighborIDs.has(r.id)) nodes.delete(r.id);
    for (let i=edges.length-1;i>=0;i--) if (!nodes.has(edges[i]!.source)||!nodes.has(edges[i]!.target)) edges.splice(i,1);
  }
  // Project identity is derived from registration, never stored as invented knowledge.
  const project = db.prepare('SELECT id,root,name,goal FROM projects WHERE id=?').get(projectId);
  const rootPath = options.workingRoot ?? String(project?.root ?? '');
  if (project) {
    const representatives = projectRepresentatives(nodes,edges);
    nodes.set(projectId,{id:projectId,kind:'project',title:basename(rootPath) || String(project.name),summary:[project.name,rootPath,project.goal].filter(Boolean).join(' · '),status:'',uri:rootPath,degree:0});
    searchable.set(projectId,[basename(rootPath),project.name,rootPath,project.goal].join(' ').toLocaleLowerCase());
    for (const id of representatives) add(projectId,id,'contains');
  }
  const adjacency = new Map<string, Set<string>>();
  for (const e of edges) { if (e.relation === 'contains' && options.focus_id !== projectId) continue; for (const [a,b] of [[e.source,e.target],[e.target,e.source]]) { const set = adjacency.get(a!) ?? new Set<string>(); set.add(b!); adjacency.set(a!, set); } }
  const degrees = new Map<string,number>();
  for (const e of edges) {degrees.set(e.source,(degrees.get(e.source) ?? 0)+1);degrees.set(e.target,(degrees.get(e.target) ?? 0)+1);}
  for (const node of nodes.values()) node.degree = degrees.get(node.id) ?? 0;
  const words = options.query?.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const matches = [...nodes.values()].filter(n => words.length && words.every(w => searchable.get(n.id)!.includes(w))).map(n => n.id);
  const selected = new Set<string>();
  const seeds = options.focus_id ? (nodes.has(options.focus_id) ? [options.focus_id] : []) : words.length ? matches : [];
  let frontier = seeds.slice(0, limit); frontier.forEach(id => selected.add(id));
  if (options.focus_id || words.length) {
    for (let hop=0; hop<depth; hop++) { const next: string[] = []; for (const id of frontier) for (const other of adjacency.get(id) ?? []) if (!selected.has(other) && selected.size < limit) { selected.add(other); next.push(other); } frontier = next; }
  } else {
    const priority = new Set(options.priority_ids ?? []);
    [...nodes.values()].sort((a,b) => Number(b.kind === 'project') - Number(a.kind === 'project') || Number(b.id === options.include_id) - Number(a.id === options.include_id) || Number(priority.has(b.id)) - Number(priority.has(a.id)) || Number(neighborIDs.has(b.id)) - Number(neighborIDs.has(a.id)) || Number(b.kind === 'concept') - Number(a.kind === 'concept') || b.degree - a.degree).slice(0,limit).forEach(n => selected.add(n.id));
  }
  let returnedEdges = edges.filter(e => selected.has(e.source) && selected.has(e.target));
  if (project && selected.has(projectId) && !options.focus_id && !words.length) {
    const visible = new Map([...nodes].filter(([id]) => id !== projectId && selected.has(id)));
    returnedEdges = returnedEdges.filter(e => e.relation !== 'contains');
    for (const id of projectRepresentatives(visible,returnedEdges)) returnedEdges.push({source:projectId,target:id,relation:'contains'});
  }
  return { nodes: [...selected].map(id => nodes.get(id)!), edges: returnedEdges.slice(0,5000), omitted_edges: Math.max(0,returnedEdges.length-5000), matches: matches.filter(id => selected.has(id)),
    backlinks: options.focus_id ? edges.filter(e => e.target === options.focus_id && selected.has(e.source)) : [],
    unresolved: unresolved.filter(v => selected.has(v.source)), total_nodes: nodes.size, total_edges: edges.length,
    omitted_nodes: nodes.size - selected.size, source_truncated: rows.length === 10000, query: options.query ?? '', focus_id: options.focus_id ?? null,
    root_id: project ? projectId : null, project: project ? {id:projectId,name:project.name,root:rootPath,registered_root:project.root} : null, view: options.view ?? 'all', note: 'Explicit links, typed record references and unambiguous [[wikilinks]]. Search uses keywords and graph traversal, not embeddings. Child edges point from concept or task parent to child. Dependencies describe work order, not hierarchy. The derived project root uses contains edges for graph membership; these are excluded from ordinary search/focus traversal.' };
}


// Search all saved project text, independently of graph/display windows. Result memory stays bounded.
export function projectSearch(db: DatabaseSync, projectId: string, input: string, options: {includeBackground?: boolean; workingRoot?: string} = {}) {
  const query = input.trim().slice(0,200);
  const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase();
  const words = normalize(query).split(/\s+/u).filter(Boolean);
  const best: {node:GraphNode;score:number;key:string}[] = []; let total = 0;
  const consider = (node:GraphNode, text:string) => {
    const full=normalize(text), title=normalize(node.title), phrase=normalize(query);
    if (!words.length || !words.every(word=>full.includes(word))) return;
    total++;
    const score=title===phrase ? 0 : title.startsWith(phrase) ? 1 : words.every(word=>title.includes(word)) ? 2 : 3;
    best.push({node,score,key:title}); best.sort((a,b)=>a.score-b.score || a.key.localeCompare(b.key) || a.node.id.localeCompare(b.node.id));
    if(best.length>50) best.pop();
  };
  for (const row of db.prepare(`SELECT id,kind,
    COALESCE(json_extract(body,'$.title'),json_extract(body,'$.name'),json_extract(body,'$.goal'),json_extract(body,'$.summary'),json_extract(body,'$.actor'),kind) AS title,
    COALESCE(json_extract(body,'$.node_type'),kind) AS node_type,
    COALESCE(json_extract(body,'$.status'),'') AS status,
    json_extract(body,'$.uri') AS uri,
    json_extract(body,'$.content') AS content,json_extract(body,'$.description') AS description,
    json_extract(body,'$.summary') AS summary,json_extract(body,'$.goal') AS goal,
    json_extract(body,'$.source') AS source,json_extract(body,'$.sql') AS sql,
    json_extract(body,'$.progress') AS progress,json_extract(body,'$.completion.summary') AS completion
    FROM records WHERE project_id=? AND COALESCE(json_extract(body,'$.status'),'')!='forgotten'
    AND (? OR (COALESCE(json_extract(body,'$.graph_role'),'')!='background' AND kind NOT IN ('session','checkpoint') AND COALESCE(json_extract(body,'$.status'),'') NOT IN ('superseded','stale','rejected')))`)
    .iterate(projectId,options.includeBackground ? 1 : 0)) {
    const body=[row.content,row.description,row.summary,row.goal,row.source,row.uri,row.sql,row.progress,row.completion].filter(v=>typeof v==='string').join(' ');
    const normalizedBody=normalize(body);const hit=words.map(word=>normalizedBody.indexOf(word)).filter(index=>index>=0).sort((a,b)=>a-b)[0] ?? 0;const start=Math.max(0,hit-60);
    const preview=(start ? '…' : '')+body.slice(start,start+320)+(body.length>start+320 ? '…' : '');
    consider({id:String(row.id),kind:String(row.node_type),title:String(row.title).slice(0,500),summary:preview,status:String(row.status),...(row.uri ? {uri:String(row.uri)} : {}),degree:0},String(row.title)+' '+body);
  }
  const project=db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  if(project) {const root=options.workingRoot ?? String(project.root);consider({id:projectId,kind:'project',title:basename(root),summary:[project.name,root,project.goal].join(' · '),uri:root,status:'',degree:0},[basename(root),project.name,root,project.goal].join(' '));}
  return {query,nodes:best.map(v=>v.node),total_matches:total,omitted_matches:Math.max(0,total-best.length)};
}
