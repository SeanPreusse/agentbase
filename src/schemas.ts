import { z } from 'zod';

const text = z.string().trim().min(1).max(12000);
const short = z.string().trim().min(1).max(500);
const id = z.string().min(1).max(100);
const ids = z.array(id).max(100);
const project = { project_id: id };
const mutation = { ...project, actor: short, request_id: id };
const version = z.number().int().positive();
const page = { limit: z.number().int().min(1).max(100).default(30), offset: z.number().int().min(0).max(100000).default(0) };
export const statuses = ['proposed', 'ready', 'in_progress', 'review', 'done', 'blocked', 'cancelled'] as const;
const evidence = z.object({ kind: z.enum(['test', 'commit', 'file', 'analysis', 'manual']), reference: short, outcome: text });
const taskSource = z.object({ kind: z.enum(['record', 'web', 'document', 'file']), reference: short, title: short.optional(), note: short.optional() });
const memoryStatus = z.enum(['active', 'disputed', 'stale', 'superseded', 'forgotten']);

export const schemas = {
  mcp_status: z.object({ project_id: id.optional() }).strict(),
  project_open: z.object({ root: text, name: short.optional(), goal: text.optional() }).strict(),
  project_resume: z.object({ root: text, name: short.optional(), goal: text.optional(), task_id: id.optional(), query: short.optional(),
    max_chars: z.number().int().min(1000).max(24000).default(8000) }).strict(),
  project_list: z.object({ query: short.optional(), ...page }).strict(),
  project_attach: z.object({ ...mutation, root: text, reason: text }).strict(),
  session_start: z.object({ ...mutation, client: short, task_id: id.optional(), root: text.optional() }).strict(),
  record_get: z.object({ ...project, id }).strict(),
  knowledge_save: z.object({ ...mutation, id: id.optional(), expected_version: version.optional(), node_type: z.enum(['concept','resource']), graph_role: z.enum(['content','background']).optional(), title: short, content: text, source: text, epistemic_status: z.enum(['observed','user_stated','inferred']), parent_id: id.nullable().optional(), uri: z.string().max(2000).regex(/^(https?:\/\/|file:\/\/|\/)/).optional() }).strict(),
  graph_link: z.object({ ...mutation, source_id: id, target_id: id, expected_version: version, relation: z.enum(['related','resource']).default('related'), remove: z.boolean().default(false) }).strict(),
  graph_get: z.object({ ...project, query: short.optional(), focus_id: id.optional(), view: z.enum(['all','content']).default('all'), depth: z.number().int().min(0).max(3).default(1), limit: z.number().int().min(1).max(500).default(200) }).strict(),
  skill_save: z.object({ ...mutation, id: id.optional(), expected_version: version.optional(), title: short, description: text,
    triggers: z.array(short).max(50).default([]), tags: z.array(short).max(50).default([]), applies_to: z.array(short).max(50).default([]),
    source: z.string().trim().min(1).max(2000).regex(/^(https?:\/\/|file:\/\/|\/)/), category: z.enum(['General','Coding','Research','Data','Planning','Writing']).default('General'), status: z.enum(['active','disabled']).default('active') }).strict(),
  skill_list: z.object({ ...project, query: short.optional(), status: z.enum(['active','disabled','all']).default('active'), ...page }).strict(),
  skill_recommend: z.object({ ...project, task_id: id.optional(), query: short.optional(), limit: z.number().int().min(1).max(20).default(5) }).strict(),
  search: z.object({ ...project, query: short, kind: z.enum(['task', 'memory', 'decision', 'plan', 'checkpoint', 'analysis', 'dataset']).optional(), ...page }).strict(),
  plan_save: z.object({ ...mutation, id: id.optional(), expected_version: version.optional(), goal: text,
    milestones: z.array(z.object({ title: short, acceptance: text })).min(1).max(50),
    constraints: z.array(short).max(50).default([]), assumptions: z.array(short).max(50).default([]),
    open_questions: z.array(short).max(50).default([]) }).strict(),
  task_create: z.object({ ...mutation, title: short, description: text, acceptance: z.array(short).min(1).max(30),
    status: z.enum(['proposed', 'ready']).default('ready'), priority: z.number().int().min(0).max(4).default(2),
    dependencies: ids.default([]), related_ids: ids.default([]), sources: z.array(taskSource).max(100).default([]), plan_id: id.optional(), parent_task_id: id.optional(),
    requires_evidence: z.boolean().default(true) }).strict(),
  task_list: z.object({ ...project, status: z.enum(statuses).optional(), parent_task_id: id.optional(), ready_only: z.boolean().default(false), ...page }).strict(),
  task_update: z.object({ ...mutation, id, expected_version: version, title: short.optional(), description: text.optional(),
    acceptance: z.array(short).min(1).max(30).optional(), dependencies: ids.optional(), sources: z.array(taskSource).max(100).optional(), parent_task_id: id.nullable().optional(),
    priority: z.number().int().min(0).max(4).optional(),
    status: z.enum(['proposed', 'ready', 'review', 'blocked', 'cancelled']).optional(), reason: text.optional() }).strict(),
  task_claim: z.object({ ...mutation, id, expected_version: version,
    lease_seconds: z.number().int().min(30).max(86400).default(1800) }).strict(),
  task_complete: z.object({ ...mutation, id, expected_version: version, summary: text,
    evidence: z.array(evidence).max(30).default([]) }).strict(),
  memory_record: z.object({ ...mutation, kind: z.enum(['fact', 'lesson', 'constraint', 'decision']), title: short, content: text,
    source: text, epistemic_status: z.enum(['observed', 'user_stated', 'inferred']), graph_role: z.enum(['content','background']).optional(),
    scope: z.enum(['project', 'task']).default('project'), task_id: id.optional(), related_ids: ids.default([]),
    alternatives: z.array(short).max(30).default([]), supersedes: id.optional() }).strict(),
  memory_update: z.object({ ...mutation, id, expected_version: version, status: memoryStatus, graph_role: z.enum(['content','background']).optional(), reason: text }).strict(),
  checkpoint_save: z.object({ ...mutation, session_id: id, task_id: id.optional(), summary: text, next_action: text,
    completed: z.array(short).max(50).default([]), remaining: z.array(short).max(50).default([]),
    blockers: z.array(short).max(30).default([]), failed_approaches: z.array(short).max(30).default([]),
    evidence: z.array(evidence).max(30).default([]), related_ids: ids.default([]),
    task_progress: z.object({ expected_version: version, summary: text }).optional() }).strict(),
  handoff_get: z.object({ ...project, task_id: id.optional(), root: text.optional() }).strict(),
  context_get: z.object({ ...project, task_id: id.optional(), query: short.optional(), root: text.optional(),
    max_chars: z.number().int().min(1000).max(24000).default(8000) }).strict(),
  dataset_import: z.object({ ...mutation, path: text, name: short, root: text.optional(), related_ids: ids.default([]) }).strict(),
  dataset_inspect: z.object({ ...project, id }).strict(),
  analysis_run: z.object({ ...mutation, title: short, sql: z.string().trim().min(1).max(16000),
    dataset_ids: ids.min(1).max(10), task_id: id.optional(),
    interpretation: text.optional(), max_rows: z.number().int().min(1).max(1000).default(100) }).strict(),
  artifact_export: z.object({ ...project, analysis_id: id, format: z.enum(['json', 'csv']).default('json') }).strict(),
  project_export: z.object(project).strict(),
  project_backup: z.object({ ...mutation, destination: text }).strict(),
  backup_verify: z.object({ backup_path: text }).strict(),
  project_restore: z.object({ backup_path: text, root: text, actor: short, request_id: id }).strict(),
} as const;
export type ToolName = keyof typeof schemas;
export type Inputs = { [K in ToolName]: z.infer<(typeof schemas)[K]> };
