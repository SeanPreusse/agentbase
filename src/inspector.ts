import { DatabaseSync } from 'node:sqlite';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { VERSION } from './version.js';
import { operationsView } from './operations.js';
import { projectGraph, projectSearch } from './graph.js';
import { recommendSkills } from './skills.js';

type EmptyGraph = { nodes: never[]; edges: never[]; omitted_nodes: number; total_nodes: number; unresolved: never[] };
type OverviewGraph = { nodes: ReturnType<typeof projectGraph>['nodes']; edges: ReturnType<typeof projectGraph>['edges']; total_nodes: number; omitted_nodes: number; unresolved: ReturnType<typeof projectGraph>['unresolved'] };
type DerivedCache = { revision: number; dataVersion?: number; key?: string; graph?: ReturnType<typeof projectGraph> | OverviewGraph | EmptyGraph; graphSearch?: ReturnType<typeof projectSearch> };
export const ALL_PROJECTS_ID = 'agentbase:all';

function taskSkillRecommendations(db: DatabaseSync, task: any) {
  if (!task || task.kind !== 'task') return undefined;
  const skills = db.prepare("SELECT id,version,body FROM records WHERE project_id=? AND kind='skill'").all(task.project_id).map(row => ({ ...row, body: JSON.parse(String(row.body)) })) as any[];
  const context = [task.body.title, task.body.description, ...(task.body.acceptance ?? [])].filter(Boolean).join(' ');
  return recommendSkills(skills, context).slice(0, 5);
}

// A separate read-only connection: no Store initialization, migrations or project registration.
export function inspectorSnapshot(home: string, projectId?: string, recordId?: string, options: { includeBackground?: boolean; taskLimit?: number; workingRoot?: string; search?: string; derivedCache?: DerivedCache } = {}) {
  const taskLimit = Number.isFinite(options.taskLimit) ? Math.min(1000, Math.max(200, Math.floor(options.taskLimit!))) : 200;
  const base = { version: VERSION, captured_at: new Date().toISOString(), home };
  const filename = join(home, 'agentbase.sqlite');
  if (!existsSync(filename)) return { ...base, status: 'empty', projects: [], records: [], events: [], counts: {}, omitted: 0 };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(filename, { readOnly: true, timeout: 1000 });
    db.exec('PRAGMA query_only=ON; BEGIN;');
    const schema = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
    if (schema !== '2') throw new Error('Unsupported store schema. Use a compatible Agentbase release.');
    const projects = db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM records r WHERE r.project_id=p.id AND r.kind='task') AS task_count,
      (SELECT MAX(at) FROM events e WHERE e.project_id=p.id) AS last_activity
      FROM projects p ORDER BY COALESCE(last_activity,p.created_at) DESC,p.id`).all();
    if (projectId === ALL_PROJECTS_ID) {
      const counts: Record<string, number> = {};
      for (const row of db.prepare('SELECT kind,COUNT(*) AS n FROM records GROUP BY kind').all()) counts[String(row.kind)] = Number(row.n);
      const rows = db.prepare("SELECT * FROM records WHERE kind='task' ORDER BY updated_at DESC,rowid DESC LIMIT ?").all(taskLimit) as any[];
      const records: any[] = rows.map(row => ({ ...row, body: JSON.parse(String(row.body)) }));
      if (recordId && !records.some(row => row.id === recordId)) {
        const focused = db.prepare('SELECT * FROM records WHERE id=?').get(recordId) as any;
        if (focused) {
          const body = JSON.parse(String(focused.body));
          if (body.status !== 'forgotten') {
            if (focused.kind === 'analysis') {body.inspector_rows_omitted = Math.max(0,body.rows.length-1000);body.rows = body.rows.slice(0,1000);}
            records.push({...focused,body});
          }
        }
      }
      for (const task of records.filter(row => row.kind === 'task')) {
        task.dependencies = db!.prepare(`SELECT r.id,json_extract(r.body,'$.title') AS title,json_extract(r.body,'$.status') AS status
          FROM dependencies d JOIN records r ON r.id=d.depends_on WHERE d.task_id=?`).all(task.id);
        task.lease_active = !!task.body.owner && Date.parse(task.body.lease_expires_at ?? '') > Date.now();
      }
      const events = db.prepare(`SELECT e.*, COALESCE(json_extract(r.body,'$.title'),json_extract(r.body,'$.name'),json_extract(r.body,'$.summary'),r.kind) AS record_title,
        r.kind AS record_kind FROM events e LEFT JOIN records r ON r.id=e.record_id AND r.project_id=e.project_id
        ORDER BY e.seq DESC LIMIT 100`).all();
      const cache = options.derivedCache;
      const cacheKey = `${cache?.revision}:${JSON.stringify([ALL_PROJECTS_ID, recordId, !!options.includeBackground, options.search?.trim() ?? '', taskLimit])}`;
      const reuse = cache?.key === cacheKey && cache.graph;
      let graph: OverviewGraph;
      if (reuse) graph = cache.graph as OverviewGraph;
      else {
        const nodes: OverviewGraph['nodes'] = [], edges: OverviewGraph['edges'] = [], unresolved: OverviewGraph['unresolved'] = [];
        let totalNodes = 0;
        const projectBudget = Math.max(1, Math.floor(350 / Math.max(1, projects.length)));
        for (const project of projects) {
          const projectTasks = records.filter(task => task.kind === 'task' && task.project_id === project.id).slice(0, 8);
          const part = projectGraph(db, String(project.id), {
            workingRoot: String(project.root), limit: projectBudget, include_id: records.find(row => row.id === recordId && row.project_id === project.id)?.id,
            priority_ids: projectTasks.map(task => String(task.id)), view: options.includeBackground ? 'all' : 'content',
          });
          nodes.push(...part.nodes);
          edges.push(...part.edges);
          unresolved.push(...part.unresolved);
          totalNodes += part.total_nodes;
        }
        graph = {nodes,edges,total_nodes:totalNodes,omitted_nodes:Math.max(0,totalNodes-nodes.length),unresolved};
      }
      const phrase = options.search?.trim().slice(0,200) ?? '';
      let graphSearch: ReturnType<typeof projectSearch> | undefined;
      if (phrase) {
        if (reuse) graphSearch = cache!.graphSearch;
        else {
          const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase();
          const normalized = normalize(phrase), words = normalized.split(/\s+/u).filter(Boolean);
          const matches: ReturnType<typeof projectSearch>['nodes'] = [];
          let totalMatches = 0;
          for (const project of projects) {
            const result = projectSearch(db,String(project.id),phrase,{includeBackground:options.includeBackground,workingRoot:String(project.root)});
            totalMatches += result.total_matches;
            matches.push(...result.nodes.map(node => ({...node,summary:`${project.name} · ${node.summary}`})));
          }
          const rank = (title: string) => {
            const value = normalize(title);
            return value === normalized ? 0 : value.startsWith(normalized) ? 1 : words.every(word => value.includes(word)) ? 2 : 3;
          };
          matches.sort((a,b) => rank(a.title)-rank(b.title) || normalize(a.title).localeCompare(normalize(b.title)) || a.id.localeCompare(b.id));
          graphSearch = {query:phrase,nodes:matches.slice(0,50),total_matches:totalMatches,omitted_matches:Math.max(0,totalMatches-50)};
        }
      }
      if (cache && !reuse) { cache.key = cacheKey; cache.graph = graph; cache.graphSearch = graphSearch; }
      const skillRecommendations = taskSkillRecommendations(db, records.find(record => record.id === recordId));
      db.exec('COMMIT;');
      return {...base,status:'connected',projects,selected_project_id:ALL_PROJECTS_ID,records,events,counts,omitted:Math.max(0,(counts.task ?? 0)-records.length),focused_record_id:recordId,graph,graph_search:graphSearch,operations_tasks_omitted:Math.max(0,(counts.task ?? 0)-records.length),skill_recommendations:skillRecommendations};
    }
    const workspace = options.workingRoot ? realpathSync(resolve(options.workingRoot)) : undefined;
    const registered = db.prepare('SELECT root,project_id FROM project_roots').all();
    const matching = workspace ? registered.filter(row => {
      const rel = relative(String(row.root),workspace); return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
    }).sort((a,b) => String(b.root).length-String(a.root).length)[0] : undefined;
    const selected = projectId ? projects.find(p => p.id === projectId) : workspace ? projects.find(p => p.id === matching?.project_id) : projects[0];
    if (workspace && !projectId && !selected) {
      db.exec('COMMIT;');
      return {...base,status:'error',error:'This folder has no registered Agentbase project. Open it with project_open first; choose a project explicitly to inspect other work.',projects,records:[],events:[],counts:{},omitted:0};
    }
    const workingRoot = matching && matching.project_id === selected?.id ? String(matching!.root) : selected ? String(selected.root) : undefined;
    if (projectId && !selected) {
      db.exec('COMMIT;');
      return { ...base, status: 'error', error: 'Selected project is no longer available. Choose another project.', projects, records: [], events: [], counts: {}, omitted: 0 };
    }
    const counts: Record<string, number> = {};
    const taskSummary: Record<string, number> = {};
    const records: any[] = [];
    let omitted = 0;
    if (selected) {
      const now = new Date().toISOString();
      const aggregate = db.prepare(`SELECT
        SUM(CASE WHEN json_extract(r.body,'$.owner') IS NOT NULL AND json_extract(r.body,'$.lease_expires_at') > ? THEN 1 ELSE 0 END) AS leased,
        SUM(CASE WHEN json_extract(r.body,'$.status')='done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN json_extract(r.body,'$.status')='ready' AND NOT EXISTS (
          SELECT 1 FROM dependencies d JOIN records prerequisite ON prerequisite.id=d.depends_on
          WHERE d.task_id=r.id AND json_extract(prerequisite.body,'$.status')!='done') THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN json_extract(r.body,'$.status') NOT IN ('done','cancelled') AND
          (json_extract(r.body,'$.status')='blocked' OR EXISTS (
          SELECT 1 FROM dependencies d JOIN records prerequisite ON prerequisite.id=d.depends_on
          WHERE d.task_id=r.id AND json_extract(prerequisite.body,'$.status')!='done')) THEN 1 ELSE 0 END) AS blocked
        FROM records r WHERE project_id=? AND kind='task'`).get(now, selected.id!);
      for (const [key, value] of Object.entries(aggregate ?? {})) taskSummary[key] = Number(value ?? 0);
      for (const row of db.prepare("SELECT kind,COUNT(*) AS n FROM records WHERE project_id=? GROUP BY kind").all(selected.id!)) counts[String(row.kind)] = Number(row.n);
      // Bound each kind independently so large task histories never hide memories or handoffs.
      for (const kind of ['task', 'plan', 'checkpoint', 'memory', 'decision', 'session', 'dataset', 'analysis']) {
        const rows = db.prepare('SELECT * FROM records WHERE project_id=? AND kind=? ORDER BY updated_at DESC,rowid DESC LIMIT ?').all(selected.id!, kind, kind === 'task' ? taskLimit : 200);
        omitted += Math.max(0, (counts[kind] ?? 0) - rows.length);
        for (const row of rows) {
          const body = JSON.parse(String(row.body));
          if (body.status === 'forgotten') continue;
          // Keep the stream bounded; full saved results remain accessible through MCP.
          if (kind === 'analysis') { const rowLimit = row.id === recordId ? 1000 : 20; body.inspector_rows_omitted = Math.max(0, body.rows.length - rowLimit); body.rows = body.rows.slice(0, rowLimit); }
          records.push({ ...row, body });
        }
      }
      if (recordId && !records.some(r => r.id === recordId)) {
        const row = db.prepare('SELECT * FROM records WHERE id=? AND project_id=?').get(recordId, selected.id!);
        if (row) {
          const body = JSON.parse(String(row.body));
          if (body.status !== 'forgotten') {
            if (row.kind === 'analysis') { const rowLimit = row.id === recordId ? 1000 : 20; body.inspector_rows_omitted = Math.max(0, body.rows.length - rowLimit); body.rows = body.rows.slice(0, rowLimit); }
            records.push({ ...row, body }); omitted = Math.max(0, omitted - 1);
          }
        }
      }
      const tasks = new Map(records.filter(r => r.kind === 'task').map(r => [r.id, r]));
      for (const task of tasks.values()) {
        const dependencies = db.prepare(`SELECT r.id,json_extract(r.body,'$.title') AS title,json_extract(r.body,'$.status') AS status
          FROM dependencies d JOIN records r ON r.id=d.depends_on WHERE d.task_id=?`).all(task.id);
        task.dependencies = dependencies;
        task.lease_active = !!task.body.owner && Date.parse(task.body.lease_expires_at ?? '') > Date.now();
      }
    }
    const focused = recordId && selected ? db.prepare(`SELECT r.id,r.kind,COALESCE(json_extract(r.body,'$.title'),json_extract(r.body,'$.name'),json_extract(r.body,'$.summary'),json_extract(r.body,'$.goal'),json_extract(r.body,'$.actor')) AS title
      FROM links l JOIN records r ON r.id=CASE WHEN l.source_id=? THEN l.target_id ELSE l.source_id END
      WHERE (l.source_id=? OR l.target_id=?) AND r.project_id=?
      AND COALESCE(json_extract(r.body,'$.status'),'')!='forgotten' GROUP BY r.id LIMIT 30`).all(recordId, recordId, recordId, selected.id!) : [];
    const events = selected ? db.prepare(`SELECT e.*, COALESCE(json_extract(r.body,'$.title'),json_extract(r.body,'$.name'),json_extract(r.body,'$.summary'),json_extract(r.body,'$.actor'),r.kind) AS record_title, r.kind AS record_kind FROM events e LEFT JOIN records r ON r.id=e.record_id AND r.project_id=e.project_id AND COALESCE(json_extract(r.body,'$.status'),'')!='forgotten' WHERE e.project_id=? ORDER BY e.seq DESC LIMIT 100`).all(selected.id!) : [];
    const cacheKey = JSON.stringify([selected?.id, recordId, workingRoot, !!options.includeBackground, options.search?.trim() ?? '']);
    const cache = options.derivedCache;
    const reuse = cache && cache.revision >= 0 && cache.key === `${cache.revision}:${cacheKey}`;
    const graph = reuse ? cache.graph! : selected ? projectGraph(db, String(selected.id), { workingRoot, limit: 350, include_id: recordId, view: options.includeBackground ? 'all' : 'content' }) : { nodes: [], edges: [], omitted_nodes: 0, total_nodes: 0, unresolved: [] };
    const graphSearch = reuse ? cache.graphSearch : selected && options.search?.trim() ? projectSearch(db,String(selected.id),options.search,{includeBackground:options.includeBackground,workingRoot}) : undefined;
    if (cache && !reuse) { cache.key = `${cache.revision}:${cacheKey}`; cache.graph = graph; cache.graphSearch = graphSearch; }
    const operationalTasks = selected ? db.prepare(`SELECT id,project_id,kind,version,created_at,updated_at,
      json_object('title',json_extract(body,'$.title'),'status',json_extract(body,'$.status'),'owner',json_extract(body,'$.owner'),
        'lease_expires_at',json_extract(body,'$.lease_expires_at'),'priority',json_extract(body,'$.priority'),
        'progress',json_extract(body,'$.progress'),'reason',json_extract(body,'$.reason')) AS body
      FROM records WHERE project_id=? AND kind='task'
      ORDER BY CASE WHEN json_extract(body,'$.status') NOT IN ('done','cancelled') THEN 0 ELSE 1 END,updated_at DESC,rowid DESC LIMIT 10000`).all(selected.id!).map(row => ({ ...row, body: JSON.parse(String(row.body)) })) : [];
    const dependencies = selected ? db.prepare(`SELECT d.task_id,r.id,json_extract(r.body,'$.title') AS title,json_extract(r.body,'$.status') AS status
      FROM dependencies d JOIN records r ON r.id=d.depends_on JOIN records t ON t.id=d.task_id WHERE t.project_id=?`).all(selected.id!) : [];
    const byTask = new Map<string, any[]>();
    for (const dependency of dependencies) { const key = String(dependency.task_id); const values = byTask.get(key) ?? []; values.push(dependency); byTask.set(key, values); }
    const operations = operationsView(operationalTasks.map(t => ({ ...t, dependencies: byTask.get(String((t as any).id)) ?? [] })) as any, events as any);
    const skillRecommendations = taskSkillRecommendations(db, records.find(record => record.id === recordId));
    db.exec('COMMIT;');
    return { ...base, status: 'connected', projects, selected_project_id: selected?.id, working_root: workingRoot, counts, task_summary: taskSummary, records, events, omitted, related: focused, focused_record_id: recordId, operations, graph, graph_search: graphSearch, operations_tasks_omitted: Math.max(0, (counts.task ?? 0) - operationalTasks.length), skill_recommendations: skillRecommendations };
  } catch (error) {
    return { ...base, status: 'error', error: (error as Error).message, projects: [], records: [], events: [], counts: {}, omitted: 0 };
  } finally { db?.close(); }
}

export async function watchInspector(home: string, projectId?: string, recordId?: string, options: { includeBackground?: boolean; taskLimit?: number; workingRoot?: string; search?: string } = {}) {
  let stop = false;
  const derivedCache: DerivedCache = { revision: 0 };
  let snapshotDirty = true;
  let lastSnapshotAt = 0;
  let monitor: DatabaseSync | undefined;
  let monitorIdentity = '';
  const stopWatching = () => { stop = true; };
  process.once('SIGTERM', stopWatching); process.once('SIGINT', stopWatching);
  process.stdout.on('error', stopWatching);
  try {
    while (!stop) {
      const filename = join(home, 'agentbase.sqlite');
      if (existsSync(filename)) {
        try {
          const file = statSync(filename), identity = `${file.dev}:${file.ino}`;
          if (identity !== monitorIdentity) { monitor?.close(); monitor = new DatabaseSync(filename, { readOnly: true, timeout: 1000 }); monitorIdentity = identity; derivedCache.revision++; snapshotDirty = true; }
          const dataVersion = Number(monitor!.prepare('PRAGMA data_version').get()?.data_version ?? 0);
          if (Number.isFinite(dataVersion)) {
            if (derivedCache.dataVersion !== undefined && derivedCache.dataVersion !== dataVersion) { derivedCache.revision++; snapshotDirty = true; }
            derivedCache.dataVersion = dataVersion;
          } else { derivedCache.revision++; snapshotDirty = true; }
        } catch {
          monitor?.close(); monitor = undefined; monitorIdentity = ''; derivedCache.revision++; snapshotDirty = true;
        }
      } else {
        if (monitor || monitorIdentity) { monitor?.close(); monitor = undefined; monitorIdentity = ''; derivedCache.revision++; snapshotDirty = true; }
      }
      const now = Date.now();
      if (snapshotDirty || now - lastSnapshotAt >= 5000) {
        const line = JSON.stringify(inspectorSnapshot(home, projectId, recordId, { ...options, derivedCache })) + '\n';
        if (!process.stdout.write(line)) await new Promise<void>(resolve => {
          const finish = () => { process.stdout.removeListener('drain', finish); process.stdout.removeListener('error', finish); resolve(); };
          process.stdout.once('drain', finish); process.stdout.once('error', finish);
        });
        snapshotDirty = false;
        lastSnapshotAt = now;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally { monitor?.close(); process.removeListener('SIGTERM', stopWatching); process.removeListener('SIGINT', stopWatching); }
}
