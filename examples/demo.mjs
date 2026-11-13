import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agentbase } from '../dist/service.js';
import { Store } from '../dist/store.js';

const directory = await mkdtemp(join(tmpdir(), 'agentbase-demo-'));
const root = join(directory, 'project'); await mkdir(root);
let store = new Store(join(directory, 'state'));
let agentbase = new Agentbase(store);
try {
  const project = await agentbase.call('project_open', { root, name: 'Import reliability', goal: 'Find and fix repeated import failures.' });
  const write = (tool, input) => agentbase.call(tool, { project_id: project.id, actor: 'codex-demo', request_id: randomUUID(), ...input });
  const plan = await write('plan_save', { goal: project.goal, milestones: [{ title: 'Diagnose and fix', acceptance: 'Evidence identifies the issue and a repeatable check covers the fix.' }] });
  let task = await write('task_create', { title: 'Investigate import errors', description: 'Use service error counts to decide what to fix.', acceptance: ['Save error totals and an actionable next step.'], plan_id: plan.id });
  task = await write('task_claim', { id: task.id, expected_version: task.version });
  const session = await write('session_start', { client: 'codex-demo', task_id: task.id });
  await writeFile(join(root, 'errors.csv'), 'service,errors\nimports,5\nexports,2\nimports,3\n');
  const dataset = await write('dataset_import', { path: 'errors.csv', name: 'Service errors', related_ids: [task.id] });
  const analysis = await write('analysis_run', { title: 'Errors by service', dataset_ids: [dataset.id], task_id: task.id,
    sql: 'SELECT service, sum(errors) AS total FROM d1 GROUP BY service ORDER BY total DESC' });
  const finding = await write('memory_record', { kind: 'fact', title: 'Imports have the most errors', content: 'Imports account for 8 of the 10 errors in this dataset.',
    source: analysis.id, epistemic_status: 'observed', related_ids: [analysis.id, task.id] });
  await write('checkpoint_save', { session_id: session.id, task_id: task.id, summary: 'Saved the data and investigation.', next_action: 'Inspect the import path for repeated processing.',
    completed: ['Imported immutable error data', 'Computed error totals'], remaining: ['Inspect and reproduce the import issue'], related_ids: [finding.id, analysis.id],
    task_progress: { expected_version: task.version, summary: 'Error counts identify imports as the first investigation target.' } });
  store.close();
  store = new Store(join(directory, 'state'));
  agentbase = new Agentbase(store);
  const context = await agentbase.call('context_get', { project_id: project.id, task_id: task.id });
  console.log('Fresh session recovered:\n');
  console.log(context.content);
  task = await agentbase.call('record_get', { project_id: project.id, id: task.id });
  const completed = await write('task_complete', { id: task.id, expected_version: task.version,
    summary: 'Investigation recorded; the next implementation task can target repeated import processing.',
    evidence: [{ kind: 'analysis', reference: analysis.id, outcome: 'Imports total 8 errors; exports total 2.' }] });
  console.log('\nTask status:', completed.body.status, `(${completed.body.completion.verification})`);
} finally { store.close(); await rm(directory, { recursive: true, force: true }); }
