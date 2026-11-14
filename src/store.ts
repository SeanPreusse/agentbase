import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { invariant } from './errors.js';

export interface RecordData {
  id: string; project_id: string; kind: string; version: number;
  created_at: string; updated_at: string; body: Record<string, any>;
}
export interface ProjectData {
  id: string; root: string; name: string; goal: string; created_at: string; repository_key: string | null;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([,v]) => v !== undefined)
    .sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const newId = (kind: string) => `${kind}_${randomUUID()}`;

// journal_mode can return SQLITE_BUSY immediately during concurrent first opens,
// even with SQLite's busy timeout. Only retry initialization, never an arbitrary write.
function initializeWithRetry<T>(operation: () => T): T {
  const deadline = Date.now() + 5000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let delay = 10;
  for (;;) {
    try { return operation(); }
    catch (error: any) {
      const code = typeof error.errcode === 'number' ? error.errcode & 0xff : null;
      if ((code !== 5 && code !== 6) || Date.now() >= deadline) throw error;
      Atomics.wait(wait, 0, 0, Math.min(delay, deadline - Date.now()));
      delay = Math.min(delay * 2, 100);
    }
  }
}

export class Store {
  db: DatabaseSync;
  constructor(public home: string, public clock: () => number = Date.now) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.home = home = realpathSync(home);
    const filename = join(home, 'agentbase.sqlite');
    this.db = initializeWithRetry(() => new DatabaseSync(filename, { timeout: 5000 }));
    try {
      chmodSync(filename, 0o600);
      initializeWithRetry(() => this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;'));
      initializeWithRetry(() => this.migrate());
    } catch (error) { this.db.close(); throw error; }
  }
  private migrate() {
    this.transaction(() => {
      const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
      const current = exists ? this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value : undefined;
      invariant(!exists || current === '1' || current === '2', 'SCHEMA_VERSION', 'Unsupported database version; use a compatible Agentbase release.');
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('schema_version', '1');
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, name TEXT NOT NULL, goal TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL,
        version INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_project ON records(project_id, kind, updated_at);
      CREATE TABLE IF NOT EXISTS dependencies (
        task_id TEXT NOT NULL REFERENCES records(id), depends_on TEXT NOT NULL REFERENCES records(id),
        PRIMARY KEY(task_id, depends_on), CHECK(task_id != depends_on));
      CREATE TABLE IF NOT EXISTS links (
        source_id TEXT NOT NULL REFERENCES records(id), target_id TEXT NOT NULL REFERENCES records(id),
        PRIMARY KEY(source_id, target_id));
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
        record_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL,
        version INTEGER NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (
        project_id TEXT NOT NULL REFERENCES projects(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        result TEXT NOT NULL, PRIMARY KEY(project_id, request_id));
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(id UNINDEXED, project_id UNINDEXED, text, tokenize='unicode61');
      `);
      if (current !== '2') {
        this.db.exec(`
          ALTER TABLE projects ADD COLUMN repository_key TEXT;
          CREATE UNIQUE INDEX projects_repository ON projects(repository_key) WHERE repository_key IS NOT NULL;
          CREATE TABLE project_roots (
            root TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), created_at TEXT NOT NULL);
          INSERT INTO project_roots SELECT root, id, created_at FROM projects;
          UPDATE meta SET value='2' WHERE key='schema_version';
        `);
      }
    });
  }
  now() { return new Date(this.clock()).toISOString(); }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  project(id: string): ProjectData {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    invariant(row, 'NOT_FOUND', 'Project not found.');
    return { ...row } as unknown as ProjectData;
  }
  projects(): ProjectData[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC,id').all().map(row => ({ ...row } as unknown as ProjectData));
  }
  roots(projectId: string): string[] {
    return this.db.prepare('SELECT root FROM project_roots WHERE project_id=? ORDER BY created_at,root').all(projectId).map(row => row.root as string);
  }
  decode(row: any): RecordData { return { ...row, body: JSON.parse(row.body) }; }
  get(projectId: string, id: string, kind?: string): RecordData {
    const row = this.db.prepare('SELECT * FROM records WHERE project_id=? AND id=?').get(projectId, id);
    invariant(row && (!kind || row.kind === kind), 'NOT_FOUND', `Record ${id} not found in this project.`);
    return this.decode(row);
  }
  all(projectId: string, kind?: string): RecordData[] {
    const rows = kind ? this.db.prepare('SELECT * FROM records WHERE project_id=? AND kind=? ORDER BY updated_at DESC, rowid DESC').all(projectId, kind)
      : this.db.prepare('SELECT * FROM records WHERE project_id=? ORDER BY updated_at DESC, rowid DESC').all(projectId);
    return rows.map(row => this.decode(row));
  }
  create(projectId: string, kind: string, body: Record<string, any>, actor: string): RecordData {
    const record: RecordData = { id: newId(kind), project_id: projectId, kind, version: 1, body, created_at: this.now(), updated_at: this.now() };
    this.db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').run(record.id, projectId, kind, 1, JSON.stringify(body), record.created_at, record.updated_at);
    this.index(record); this.event(record, 'created', actor);
    return record;
  }
  update(record: RecordData, expected: number, body: Record<string, any>, actor: string, action = 'updated'): RecordData {
    invariant(record.version === expected, 'VERSION_CONFLICT', 'Record changed; read it and reconcile before retrying.', { current: record });
    const updated = { ...record, version: record.version + 1, body, updated_at: this.now() };
    const result = this.db.prepare('UPDATE records SET version=?,body=?,updated_at=? WHERE id=? AND version=?')
      .run(updated.version, JSON.stringify(body), updated.updated_at, record.id, expected);
    invariant(result.changes === 1, 'VERSION_CONFLICT', 'Record changed. Read it before retrying.');
    this.index(updated); this.event(updated, action, actor);
    return updated;
  }
  index(record: RecordData) {
    this.db.prepare('DELETE FROM search_index WHERE id=?').run(record.id);
    if (!['forgotten', 'rejected'].includes(record.body.status)) this.db.prepare('INSERT INTO search_index VALUES (?,?,?)')
      .run(record.id, record.project_id, JSON.stringify(record.body));
  }
  event(record: RecordData, action: string, actor: string) {
    // Keep audit metadata rather than duplicate sensitive memory text in an append-only history.
    this.db.prepare('INSERT INTO events(project_id,record_id,action,actor,at,version,detail) VALUES (?,?,?,?,?,?,?)')
      .run(record.project_id, record.id, action, actor, this.now(), record.version, JSON.stringify({ kind: record.kind }));
  }
  replay<T>(projectId: string, requestId: string, tool: string, input: unknown): T | undefined {
    const prior = this.db.prepare('SELECT * FROM requests WHERE project_id=? AND request_id=?').get(projectId, requestId);
    if (!prior) return undefined;
    invariant(prior.fingerprint === hash(canonical({ tool, input })), 'IDEMPOTENCY_CONFLICT', 'This request_id was used with different arguments.');
    const receipt = JSON.parse(prior.result as string);
    return (receipt?.record_id ? this.get(projectId, receipt.record_id) : receipt) as T;
  }
  mutate<T>(projectId: string, requestId: string, tool: string, input: unknown, fn: () => T): T {
    return this.transaction(() => {
      this.project(projectId);
      const fingerprint = hash(canonical({ tool, input }));
      const prior = this.replay<T>(projectId, requestId, tool, input);
      if (prior !== undefined) return prior;
      const value = fn();
      // Record references only: retry responses hydrate current records, never resurrect forgotten content.
      const receipt = value && typeof value === 'object' && 'id' in value ? { record_id: (value as any).id } : value;
      this.db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(projectId, requestId, fingerprint, JSON.stringify(receipt));
      return value;
    });
  }
  related(projectId: string, sourceId: string, targetIds: string[]) {
    for (const target of new Set(targetIds)) {
      this.get(projectId, target);
      this.db.prepare('INSERT OR IGNORE INTO links VALUES (?,?)').run(sourceId, target);
    }
  }
  search(projectId: string, query: string, kind?: string, limit = 30, offset = 0): RecordData[] {
    const words = [...new Set(query.match(/[\p{L}\p{N}_-]+/gu) ?? [])];
    if (!words.length) return [];
    const terms = words.map(word => `"${word.replaceAll('"', '""')}"`);
    const match = terms.join(' OR ');
    const complete = terms.join(' AND ');
    return this.db.prepare(`SELECT r.* FROM search_index s JOIN records r ON r.id=s.id
      WHERE search_index MATCH ? AND r.project_id=? AND (? IS NULL OR r.kind=?)
        AND COALESCE(json_extract(r.body,'$.status'),'') NOT IN ('forgotten','rejected')
      ORDER BY CASE WHEN r.kind IN ('memory','decision') THEN
          CASE COALESCE(json_extract(r.body,'$.status'),'active') WHEN 'active' THEN 0 WHEN 'disputed' THEN 1 WHEN 'stale' THEN 2 ELSE 3 END
        ELSE 0 END,
        CASE WHEN r.id IN (SELECT id FROM search_index WHERE search_index MATCH ? AND project_id=?) THEN 0 ELSE 1 END,
        rank, r.updated_at DESC, r.id LIMIT ? OFFSET ?`)
      .all(match, projectId, kind ?? null, kind ?? null, complete, projectId, limit, offset).map(row => this.decode(row));
  }
}
