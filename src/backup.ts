import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, hash, canonical, type RecordData } from './store.js';
import { DomainError, invariant } from './errors.js';
import { repositoryIdentity } from './repository.js';
import { VERSION } from './version.js';

const MAX_FILE = 50 * 1024 * 1024;
const MAX_METADATA = 32 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const id = z.string().max(100).regex(new RegExp(`^(project|task|plan|session|memory|decision|checkpoint|dataset|analysis)_${uuid}$`));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime();
const text = z.string().min(1).max(12000);
const short = z.string().min(1).max(500);
const extension = z.enum(['.csv', '.json', '.jsonl', '.ndjson', '.parquet']);
const evidence = z.array(z.object({ kind: z.enum(['test', 'commit', 'file', 'analysis', 'manual']), reference: short, outcome: text }).passthrough()).max(30);
const recordSchema = z.object({ id, project_id: id, kind: z.enum(['task', 'plan', 'session', 'memory', 'decision', 'checkpoint', 'dataset', 'analysis']),
  version: z.number().int().positive(), created_at: timestamp, updated_at: timestamp, body: z.record(z.string(), z.unknown()) }).strict();
const recordReceipt = z.object({ record_id: id }).strict();
const attachmentReceipt = z.object({ project_id: id, working_root: text, roots: z.array(text).max(1000) }).strict();
const portableReceipt = z.union([recordReceipt, attachmentReceipt]);
const fileSchema = z.object({ sha256: digest, extension, bytes: z.number().int().min(0).max(MAX_FILE), path: z.string() }).strict();
const manifestSchema = z.object({
  format: z.literal('agentbase-project'), format_version: z.literal(1), schema_version: z.literal(2), app_version: short,
  backup_id: z.string().uuid(), created_at: timestamp, request_id: z.string().min(1).max(100), request_fingerprint: digest,
  project: z.object({ id, root: text, name: short, goal: z.string().max(12000), created_at: timestamp, repository_key: z.string().nullable() }).strict(),
  roots: z.array(text).max(1000), records: z.array(recordSchema).max(10000),
  dependencies: z.array(z.object({ task_id: id, depends_on: id }).strict()).max(100000),
  links: z.array(z.object({ source_id: id, target_id: id }).strict()).max(100000),
  events: z.array(z.object({ seq: z.number().int().positive(), project_id: id, record_id: id, action: short,
    actor: short, at: timestamp, version: z.number().int().positive(), detail: z.string().max(MAX_METADATA) }).strict()).max(100000),
  requests: z.array(z.object({ request_id: z.string().min(1).max(100), fingerprint: digest, result: portableReceipt }).strict()).max(100000),
  files: z.array(fileSchema).max(1000),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
type BackupInput = { project_id: string; actor: string; request_id: string; destination: string };
type RestoreInput = { backup_path: string; root: string; actor: string; request_id: string };

function invalid(message: string): never { throw new DomainError('BACKUP_INVALID', message); }
function validateBody(record: RecordData) {
  const body = record.body;
  const taskReference = { task_id: id.optional() };
  switch (record.kind) {
    case 'task': z.object({ title: short, description: text, acceptance: z.array(short).min(1).max(30), priority: z.number().int().min(0).max(4),
      status: z.enum(['proposed', 'ready', 'in_progress', 'review', 'done', 'blocked', 'cancelled']), requires_evidence: z.boolean(),
      plan_id: id.optional(), owner: short.optional(), lease_expires_at: timestamp.optional(),
      completion: z.object({ summary: text, evidence, reported_by: short, reported_at: timestamp, verification: z.literal('agent_reported') }).passthrough().optional(),
    }).passthrough().parse(body);
      if (body.status === 'done' && !body.completion) invalid('A completed task is missing its completion record.');
      break;
    case 'plan': z.object({ goal: text, milestones: z.array(z.object({ title: short, acceptance: text })).min(1).max(50),
      constraints: z.array(short).max(50), assumptions: z.array(short).max(50), open_questions: z.array(short).max(50) }).passthrough().parse(body); break;
    case 'session': z.object({ actor: short, client: short, root: text.optional(), ...taskReference }).passthrough().parse(body); break;
    case 'memory': case 'decision':
      if (body.status === 'forgotten') { z.object({ status: z.literal('forgotten'), forgotten_at: timestamp }).strict().parse(body); break; }
      z.object({ type: z.enum(['fact', 'lesson', 'constraint', 'decision']), title: short, content: text, source: text,
        epistemic_status: z.enum(['observed', 'user_stated', 'inferred']), scope: z.enum(['project', 'task']), ...taskReference,
        status: z.enum(['active', 'disputed', 'stale', 'superseded']), supersedes: id.optional() }).passthrough().parse(body);
      if ((record.kind === 'decision') !== (body.type === 'decision')) invalid('Memory type does not match its record kind.');
      if (body.scope === 'task' && !body.task_id) invalid('Task memory is missing its task.');
      break;
    case 'checkpoint': z.object({ session_id: id, ...taskReference, summary: text, next_action: text,
      completed: z.array(short).max(50), remaining: z.array(short).max(50), blockers: z.array(short).max(30),
      failed_approaches: z.array(short).max(30), evidence, related_ids: z.array(id).max(100),
      repository: z.object({ available: z.boolean() }).passthrough() }).passthrough().parse(body); break;
    case 'dataset': z.object({ name: short, source: text, snapshot: text, sha256: digest, bytes: z.number().int().min(0).max(MAX_FILE), extension,
      dataset_version: z.number().int().positive(), previous_version_id: id.optional(), row_count: z.string().regex(/^\d+$/),
      schema: z.array(z.object({ name: z.string(), type: z.string() })), sample: z.array(z.array(z.unknown())).max(5) }).passthrough().parse(body); break;
    case 'analysis': z.object({ title: short, sql: z.string().min(1).max(16000), ...taskReference, executed_at: timestamp, engine: short,
      datasets: z.array(z.object({ id, sha256: digest, alias: z.string() })).min(1).max(10),
      columns: z.array(z.object({ name: z.string(), type: z.string() })), rows: z.array(z.array(z.unknown())).max(1000),
      truncated: z.boolean(), max_rows: z.number().int().min(1).max(1000) }).passthrough().parse(body);
      if (body.rows.some((row: unknown[]) => row.length !== body.columns.length)) invalid('Analysis rows do not match the saved columns.');
      break;
  }
}
function validateGraph(m: Manifest) {
  const records = new Map<string, RecordData>();
  if (!m.project.id.startsWith('project_')) invalid('Invalid project ID.');
  for (const record of m.records) {
    if (record.project_id !== m.project.id || !record.id.startsWith(record.kind + '_') || records.has(record.id)) invalid('Record identity or project scope is invalid.');
    validateBody(record); records.set(record.id, record);
  }
  const requireRecord = (key: string, kind?: string) => {
    const record = records.get(key);
    if (!record || (kind && record.kind !== kind)) invalid(`Missing or incorrectly typed reference ${key}.`);
    return record;
  };
  for (const record of records.values()) {
    const b = record.body;
    if (b.graph_role !== undefined) z.enum(['content','background']).parse(b.graph_role);
    if (b.node_type) {
      if (record.kind !== 'memory' || !['concept','resource'].includes(b.node_type)) invalid('Invalid knowledge node.');
      if (b.node_type === 'resource' && (typeof b.uri !== 'string' || !/^(https?:\/\/|file:\/\/|\/)/.test(b.uri))) invalid('Resource node has no valid URI.');
    }
    if (b.parent_id) {
      const parent = requireRecord(b.parent_id, 'memory');
      if (parent.body.status !== 'forgotten' && parent.body.node_type !== 'concept') invalid('Knowledge parent must be a concept.');
      const visited = new Set([record.id]); let current: RecordData | undefined = parent;
      while (current) { if (visited.has(current.id)) invalid('Knowledge hierarchy contains a cycle.'); visited.add(current.id); current = current.body.parent_id ? requireRecord(current.body.parent_id, 'memory') : undefined; }
    }
    if (b.graph_links) {
      z.array(z.object({ target_id: id, relation: z.enum(['related','resource']) }).strict()).max(100).parse(b.graph_links);
      for (const link of b.graph_links) { requireRecord(link.target_id); if (link.target_id === record.id) invalid('Self links are invalid.'); }
    }
    if (b.task_id) requireRecord(b.task_id, 'task');
    if (record.kind === 'task' && b.plan_id) requireRecord(b.plan_id, 'plan');
    if (record.kind === 'checkpoint') {
      requireRecord(b.session_id, 'session'); for (const key of b.related_ids) requireRecord(key);
    }
    if (['memory', 'decision'].includes(record.kind) && b.supersedes) {
      if (b.supersedes === record.id || !['memory', 'decision'].includes(requireRecord(b.supersedes).kind)) invalid('Invalid superseded memory reference.');
    }
    if (record.kind === 'dataset' && b.previous_version_id) requireRecord(b.previous_version_id, 'dataset');
    if (record.kind === 'analysis') for (const [index, data] of b.datasets.entries()) {
      if (requireRecord(data.id, 'dataset').body.sha256 !== data.sha256 || data.alias !== `d${index + 1}`) invalid('Analysis dataset provenance is inconsistent.');
    }
    // Completion evidence uses internal analysis IDs. Checkpoints can also cite
    // external analysis references, which remain historical text rather than links.
    if (record.kind === 'task') for (const e of b.completion?.evidence ?? []) if (e.kind === 'analysis') requireRecord(e.reference, 'analysis');
  }
  const edges = new Map<string, string[]>(), pairs = new Set<string>();
  for (const edge of m.dependencies) {
    requireRecord(edge.task_id, 'task'); requireRecord(edge.depends_on, 'task');
    const pair = `${edge.task_id}:${edge.depends_on}`;
    if (pairs.has(pair)) invalid('Duplicate task dependency.'); pairs.add(pair);
    edges.set(edge.task_id, [...(edges.get(edge.task_id) ?? []), edge.depends_on]);
  }
  const pending = new Map([...records.values()].filter(r => r.kind === 'task').map(r => [r.id, edges.get(r.id)?.length ?? 0]));
  const followers = new Map<string, string[]>();
  for (const [key, deps] of edges) for (const dependency of deps) followers.set(dependency, [...(followers.get(dependency) ?? []), key]);
  const queue = [...pending].filter(([, count]) => count === 0).map(([key]) => key);
  let visited = 0;
  while (queue.length) {
    const key = queue.pop()!; visited++;
    for (const follower of followers.get(key) ?? []) { pending.set(follower, pending.get(follower)! - 1); if (pending.get(follower) === 0) queue.push(follower); }
  }
  if (visited !== pending.size) invalid('Task dependencies contain a cycle.');
  pairs.clear();
  for (const link of m.links) {
    requireRecord(link.source_id); requireRecord(link.target_id);
    const pair = `${link.source_id}:${link.target_id}`;
    if (pairs.has(pair)) invalid('Duplicate record link.'); pairs.add(pair);
  }
  pairs.clear();
  for (const event of m.events) {
    if (event.project_id !== m.project.id || pairs.has(String(event.seq))) invalid('Invalid audit event scope or sequence.');
    pairs.add(String(event.seq));
    if (event.record_id !== m.project.id) requireRecord(event.record_id);
    const detail = JSON.parse(event.detail);
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) invalid('Invalid audit event metadata.');
  }
  pairs.clear();
  for (const request of m.requests) {
    if (pairs.has(request.request_id)) invalid('Duplicate request receipt.'); pairs.add(request.request_id);
    if ('record_id' in request.result) requireRecord(request.result.record_id);
    else if (request.result.project_id !== m.project.id) invalid('Request receipt belongs to another project.');
  }
  const files = new Map<string, z.infer<typeof fileSchema>>();
  let bytes = 0;
  for (const file of m.files) {
    const expected = `datasets/${file.sha256}${file.extension}`;
    if (file.path !== expected || files.has(expected)) invalid('Invalid or duplicate backup file path.');
    files.set(expected, file); bytes += file.bytes;
  }
  if (bytes > MAX_TOTAL) invalid('Backup exceeds the 1 GiB dataset limit.');
  const usedFiles = new Set<string>();
  for (const record of records.values()) if (record.kind === 'dataset') {
    const key = `datasets/${record.body.sha256}${record.body.extension}`;
    const file = files.get(key);
    if (!file || file.bytes !== record.body.bytes) invalid('A dataset snapshot is missing or has the wrong size.');
    usedFiles.add(key);
  }
  if (usedFiles.size !== files.size) invalid('Backup contains unreferenced dataset files.');
}

async function safeRead(path: string, maximum: number) {
  const info = await lstat(path);
  invariant(info.isFile() && !info.isSymbolicLink() && info.size <= maximum, 'BACKUP_INVALID', 'Backup entries must be regular bounded files without symlinks.');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    invariant(stat.isFile() && stat.size <= maximum, 'BACKUP_INVALID', 'Backup file exceeds its size limit.');
    // A bounded read protects against a file growing after its initial stat.
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    invariant(offset === stat.size, 'BACKUP_INVALID', 'Backup file changed while it was being read.');
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}
async function readManifest(path: string): Promise<{ root: string; manifest: Manifest; checksum: string }> {
  try {
    invariant(isAbsolute(path), 'INVALID_PATH', 'Use an absolute backup directory.');
    const root = await realpath(path);
    const raw = await safeRead(join(root, 'manifest.json'), MAX_METADATA);
    const checksum = (await safeRead(join(root, 'manifest.sha256'), 100)).toString().trim();
    invariant(/^[a-f0-9]{64}$/.test(checksum) && hash(raw) === checksum, 'BACKUP_INTEGRITY', 'Backup metadata checksum does not match.');
    const manifest = manifestSchema.parse(JSON.parse(raw.toString('utf8')));
    validateGraph(manifest);
    return { root, manifest, checksum };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('BACKUP_INVALID', `Invalid or incomplete backup: ${(error as Error).message}`);
  }
}
async function readAsset(root: string, file: z.infer<typeof fileSchema>) {
  try {
    const dataDir = await lstat(join(root, 'datasets'));
    invariant(dataDir.isDirectory() && !dataDir.isSymbolicLink(), 'BACKUP_INVALID', 'Backup dataset directory must not be a symlink.');
    const buffer = await safeRead(join(root, file.path), MAX_FILE);
    invariant(buffer.length === file.bytes && hash(buffer) === file.sha256, 'BACKUP_INTEGRITY', `Dataset checksum does not match: ${file.path}`);
    return buffer;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('BACKUP_INVALID', `Missing or unreadable backup dataset: ${file.path}`);
  }
}
async function writePrivate(path: string, value: string | Buffer) {
  await writeFile(path, value, { mode: 0o600, flag: 'wx', flush: true });
}
async function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
function summary(manifest: Manifest, path: string, checksum: string) {
  return { backup_id: manifest.backup_id, backup_path: path, project_id: manifest.project.id, manifest_sha256: checksum,
    record_count: manifest.records.length, dataset_count: manifest.records.filter(r => r.kind === 'dataset').length,
    unique_dataset_files: manifest.files.length, dataset_bytes: manifest.files.reduce((total, file) => total + file.bytes, 0) };
}

export class Recovery {
  constructor(private store: Store) {}
  async verify(path: string) {
    const { root, manifest, checksum } = await readManifest(path);
    for (const file of manifest.files) await readAsset(root, file);
    return { ...summary(manifest, root, checksum), valid: true, format_version: manifest.format_version };
  }
  async backup(p: BackupInput) {
    const fingerprint = hash(canonical({ tool: 'project_backup', input: p }));
    const previous = this.store.replay(p.project_id, p.request_id, 'project_backup', p);
    if (previous !== undefined) return previous;
    invariant(isAbsolute(p.destination), 'INVALID_PATH', 'Use an absolute backup destination directory.');
    const parent = await realpath(resolve(p.destination, '..'));
    const destination = join(parent, basename(resolve(p.destination)));
    const internal = relative(this.store.home, destination);
    invariant(internal.startsWith('..' + sep) || internal === '..' || isAbsolute(internal), 'BACKUP_DESTINATION', 'Store backups outside the Agentbase data directory so they survive its loss.');
    // A completed filesystem write may exist even if a crash prevented saving its receipt.
    if (await lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
      const existing = await readManifest(destination);
      invariant(existing.manifest.request_fingerprint === fingerprint && existing.manifest.request_id === p.request_id
        && existing.manifest.project.id === p.project_id, 'BACKUP_EXISTS', 'Backup destination already exists; choose another directory.');
      await this.verify(destination);
      const result = summary(existing.manifest, existing.root, existing.checksum);
      return this.store.mutate(p.project_id, p.request_id, 'project_backup', p, () => result);
    }
    const snapshot = this.store.transaction(() => ({
      project: this.store.project(p.project_id), roots: this.store.roots(p.project_id),
      records: this.store.db.prepare('SELECT * FROM records WHERE project_id=? ORDER BY rowid').all(p.project_id).map(row => this.store.decode(row)),
      dependencies: this.store.db.prepare('SELECT d.* FROM dependencies d JOIN records r ON r.id=d.task_id WHERE r.project_id=?').all(p.project_id),
      links: this.store.db.prepare('SELECT l.* FROM links l JOIN records r ON r.id=l.source_id WHERE r.project_id=?').all(p.project_id),
      events: this.store.db.prepare('SELECT * FROM events WHERE project_id=? ORDER BY seq').all(p.project_id),
      requests: this.store.db.prepare('SELECT request_id,fingerprint,result FROM requests WHERE project_id=? ORDER BY rowid').all(p.project_id)
        .flatMap(row => { const result = portableReceipt.safeParse(JSON.parse(row.result as string)); return result.success ? [{ request_id: row.request_id, fingerprint: row.fingerprint, result: result.data }] : []; }),
    }));
    const files = new Map<string, { source: string; descriptor: z.infer<typeof fileSchema> }>();
    for (const record of snapshot.records) if (record.kind === 'dataset') {
      const b = record.body;
      const expected = join(this.store.home, 'datasets', p.project_id);
      const source = await realpath(b.snapshot);
      invariant(source.startsWith(expected + sep), 'BACKUP_INVALID', 'Dataset is outside its managed project directory.');
      const descriptor = { sha256: b.sha256, extension: b.extension, bytes: b.bytes, path: `datasets/${b.sha256}${b.extension}` };
      files.set(descriptor.path, { source, descriptor });
    }
    const manifest = manifestSchema.parse({ format: 'agentbase-project', format_version: 1, schema_version: 2, app_version: VERSION,
      backup_id: randomUUID(), created_at: this.store.now(), request_id: p.request_id, request_fingerprint: fingerprint,
      ...snapshot, files: [...files.values()].map(file => file.descriptor) });
    validateGraph(manifest);
    await mkdir(destination, { mode: 0o700 });
    let complete = false;
    try {
      await mkdir(join(destination, 'datasets'), { mode: 0o700 });
      for (const { source, descriptor } of files.values()) {
        const buffer = await safeRead(source, MAX_FILE);
        invariant(buffer.length === descriptor.bytes && hash(buffer) === descriptor.sha256, 'BACKUP_INTEGRITY', 'Stored dataset snapshot is corrupt.');
        await writePrivate(join(destination, descriptor.path), buffer);
      }
      const raw = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
      invariant(raw.length <= MAX_METADATA, 'BACKUP_SIZE', 'Backup metadata exceeds 32 MiB.');
      await syncDirectory(join(destination, 'datasets'));
      await writePrivate(join(destination, 'manifest.sha256'), hash(raw) + '\n');
      await writePrivate(join(destination, '.manifest.pending'), raw);
      await rename(join(destination, '.manifest.pending'), join(destination, 'manifest.json'));
      await syncDirectory(destination); await syncDirectory(parent);
      complete = true;
      const result = summary(manifest, destination, hash(raw));
      return this.store.mutate(p.project_id, p.request_id, 'project_backup', p, () => result);
    } finally { if (!complete) await rm(destination, { recursive: true, force: true }); }
  }
  async restore(p: RestoreInput) {
    const fingerprint = hash(canonical({ tool: 'project_restore', input: p }));
    const receipt = this.store.db.prepare('SELECT project_id FROM requests WHERE request_id=? AND fingerprint=?').get(p.request_id, fingerprint);
    if (receipt) return this.store.replay(receipt.project_id as string, p.request_id, 'project_restore', p);
    const { root: backupRoot, manifest, checksum } = await readManifest(p.backup_path);
    const identity = await repositoryIdentity(p.root);
    const conflict = () => {
      invariant(!this.store.db.prepare('SELECT 1 FROM projects WHERE id=? OR root=? OR (repository_key IS NOT NULL AND repository_key=?)').get(manifest.project.id, identity.root, identity.repository_key),
        'RESTORE_CONFLICT', 'Project ID, directory, or Git repository is already registered. Restore into a separate store or unregistered project.');
      invariant(!this.store.db.prepare('SELECT 1 FROM project_roots WHERE root=?').get(identity.root), 'RESTORE_CONFLICT', 'This directory belongs to an existing project.');
      for (const record of manifest.records) invariant(!this.store.db.prepare('SELECT 1 FROM records WHERE id=?').get(record.id), 'RESTORE_CONFLICT', 'A record ID already exists in this store.');
    };
    conflict();
    const dataRoot = join(this.store.home, 'datasets');
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const dataInfo = await lstat(dataRoot);
    invariant(dataInfo.isDirectory() && !dataInfo.isSymbolicLink() && await realpath(dataRoot) === dataRoot,
      'RESTORE_PATH', 'Managed dataset directories must remain inside the Agentbase store without symlinks.');
    const parent = join(dataRoot, manifest.project.id);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentInfo = await lstat(parent);
    invariant(parentInfo.isDirectory() && !parentInfo.isSymbolicLink() && await realpath(parent) === parent,
      'RESTORE_PATH', 'Managed project dataset directories must not be symlinks.');
    const prepared = await mkdtemp(join(parent, '.restore-'));
    let committed = false;
    try {
      for (const file of manifest.files) await writePrivate(join(prepared, basename(file.path)), await readAsset(backupRoot, file));
      await syncDirectory(prepared); await syncDirectory(parent); await syncDirectory(join(this.store.home, 'datasets')); await syncDirectory(this.store.home);
      let inserted = false;
      const result = this.store.transaction(() => {
        const retry = this.store.db.prepare('SELECT project_id FROM requests WHERE request_id=? AND fingerprint=?').get(p.request_id, fingerprint);
        if (retry) return this.store.replay(retry.project_id as string, p.request_id, 'project_restore', p);
        conflict();
        const now = this.store.now();
        this.store.db.prepare('INSERT INTO projects(id,root,name,goal,created_at,repository_key) VALUES (?,?,?,?,?,?)')
          .run(manifest.project.id, identity.root, manifest.project.name, manifest.project.goal, manifest.project.created_at, identity.repository_key);
        this.store.db.prepare('INSERT INTO project_roots VALUES (?,?,?)').run(identity.root, manifest.project.id, now);
        let resetLeases = 0;
        for (const original of manifest.records) {
          const body: Record<string, any> = structuredClone(original.body);
          let changed = false;
          if (original.kind === 'dataset') { body.snapshot = join(prepared, `${body.sha256}${body.extension}`); changed = true; }
          if (original.kind === 'session') { body.root = identity.root; changed = true; }
          if (original.kind === 'checkpoint') {
            body.repository = { ...body.repository, available: false, reason: 'Restored project; verify this checkout before resuming.', original_root: body.repository?.root, root: identity.root, restored_at: now };
            changed = true;
          }
          if (original.kind === 'task' && (body.owner || body.lease_expires_at || ['in_progress', 'review'].includes(body.status))) {
            delete body.owner; delete body.lease_expires_at;
            if (['in_progress', 'review'].includes(body.status)) { body.status = 'ready'; body.reason = 'Restored from backup; claim the task before resuming.'; }
            changed = true; resetLeases++;
          }
          const record: RecordData = { ...original, body, version: original.version + (changed ? 1 : 0), updated_at: changed ? now : original.updated_at };
          this.store.db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').run(record.id, record.project_id, record.kind, record.version, JSON.stringify(body), record.created_at, record.updated_at);
          this.store.index(record);
        }
        for (const edge of manifest.dependencies) this.store.db.prepare('INSERT INTO dependencies VALUES (?,?)').run(edge.task_id, edge.depends_on);
        for (const link of manifest.links) this.store.db.prepare('INSERT INTO links VALUES (?,?)').run(link.source_id, link.target_id);
        for (const event of manifest.events) this.store.db.prepare('INSERT INTO events(project_id,record_id,action,actor,at,version,detail) VALUES (?,?,?,?,?,?,?)')
          .run(event.project_id, event.record_id, event.action, event.actor, event.at, event.version, JSON.stringify({ ...JSON.parse(event.detail), original_event_seq: event.seq }));
        for (const request of manifest.requests) {
          const result = 'record_id' in request.result ? request.result : { project_id: manifest.project.id, working_root: identity.root, roots: [identity.root] };
          this.store.db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(manifest.project.id, request.request_id, request.fingerprint, JSON.stringify(result));
        }
        const result = { ...summary(manifest, backupRoot, checksum), working_root: identity.root, roots: [identity.root], restored: true, leases_reset: resetLeases };
        invariant(!this.store.db.prepare('SELECT 1 FROM requests WHERE project_id=? AND request_id=?').get(manifest.project.id, p.request_id), 'IDEMPOTENCY_CONFLICT', 'Choose a restore request_id not already used by the backed-up project.');
        this.store.db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(manifest.project.id, p.request_id, fingerprint, JSON.stringify(result));
        this.store.db.prepare('INSERT INTO events(project_id,record_id,action,actor,at,version,detail) VALUES (?,?,?,?,?,?,?)')
          .run(manifest.project.id, manifest.project.id, 'restored', p.actor, now, 1, JSON.stringify({ backup_id: manifest.backup_id, leases_reset: resetLeases }));
        inserted = true;
        return result;
      });
      committed = inserted;
      return result;
    } finally { if (!committed) await rm(prepared, { recursive: true, force: true }); }
  }
}
