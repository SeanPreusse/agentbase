import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Agentbase } from '../dist/service.js';
import { Store } from '../dist/store.js';

const directory = await mkdtemp(join(tmpdir(), 'agentbase-memory-baseline-'));
const root = join(directory, 'project');
const state = join(directory, 'state');
const outputFlag = process.argv.find(arg => arg.startsWith('--output='));
const report = { status: 'running', host: 'deterministic', model_calls: false, checks: [], metrics: {},
  limits: ['Synthetic project data; this measures retrieval and lifecycle behavior, not agent judgment.'] };
let store;
const check = (name, passed, detail) => report.checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });

try {
  await mkdir(root);
  store = new Store(state);
  let service = new Agentbase(store);
  const project = await service.call('project_open', { root });
  const call = (name, args = {}) => service.call(name, { project_id: project.id, ...args });
  const write = (name, args = {}) => call(name, { actor: 'baseline', request_id: randomUUID(), ...args });
  const task = await write('task_create', { title: 'Fix invoice identity', description: 'Preserve importer behavior across sessions.',
    acceptance: ['Customer and invoice number identify an invoice.'] });
  await write('task_claim', { id: task.id, expected_version: task.version });
  const session = await write('session_start', { client: 'baseline', task_id: task.id, root });
  await write('checkpoint_save', { session_id: session.id, task_id: task.id, summary: 'Importer investigation underway.',
    next_action: 'Implement composite invoice identity.' });

  const target = await write('memory_record', { kind: 'constraint', title: 'Composite invoice identity',
    content: 'Each invoice is identified by customer_id and invoice_number together.', source: 'synthetic requirement',
    epistemic_status: 'user_stated' });
  await write('memory_record', { kind: 'fact', title: 'Invoice display format',
    content: 'The visible invoice number is padded for display.', source: 'synthetic fixture', epistemic_status: 'observed' });
  await write('memory_record', { kind: 'fact', title: 'Customer label',
    content: 'Customer names are sorted alphabetically.', source: 'synthetic fixture', epistemic_status: 'observed' });
  const found = (await call('search', { query: 'composite invoice identity', limit: 3 })).records;
  report.metrics.retrieval = { precision_at_3: found.filter(record => record.id === target.id).length / Math.max(1, found.length),
    recall_at_3: found.some(record => record.id === target.id) ? 1 : 0, top_id: found[0]?.id ?? null };
  check('Relevant constraint ranks first', found[0]?.id === target.id);

  const stale = await write('memory_record', { kind: 'fact', title: 'Legacy endpoint', content: 'The legacy endpoint is /v1/invoices.',
    source: 'synthetic old spec', epistemic_status: 'observed' });
  await write('memory_update', { id: stale.id, expected_version: stale.version, status: 'stale', reason: 'New API version.' });
  const disputed = await write('memory_record', { kind: 'fact', title: 'Retry policy', content: 'The importer retries once.',
    source: 'synthetic conflicting note', epistemic_status: 'inferred' });
  await write('memory_update', { id: disputed.id, expected_version: disputed.version, status: 'disputed', reason: 'Conflicting source.' });
  const old = await write('memory_record', { kind: 'fact', title: 'Batch size', content: 'Batch size is ten rows.',
    source: 'synthetic old spec', epistemic_status: 'observed' });
  await write('memory_record', { kind: 'fact', title: 'Current batch size', content: 'Batch size is twenty rows.',
    source: 'synthetic new spec', epistemic_status: 'observed', supersedes: old.id });
  const forgotten = await write('memory_record', { kind: 'fact', title: 'Temporary token', content: 'Synthetic-secret-123.',
    source: 'synthetic fixture', epistemic_status: 'observed' });
  await write('memory_update', { id: forgotten.id, expected_version: forgotten.version, status: 'forgotten', reason: 'Remove sensitive note.' });
  const lifecycle = await call('search', { query: 'legacy endpoint retry policy batch size temporary token', limit: 30 });
  check('Stale and disputed memories retain visible status', lifecycle.records.some(record => record.id === stale.id && record.body.status === 'stale') &&
    lifecycle.records.some(record => record.id === disputed.id && record.body.status === 'disputed'));
  check('Forgotten text is absent from search', !lifecycle.records.some(record => record.id === forgotten.id));
  const forgottenRecord = await call('record_get', { id: forgotten.id });
  check('Forgotten record content is removed', !JSON.stringify(forgottenRecord.body).includes('Synthetic-secret-123'));

  for (let index = 0; index < 20; index++) await write('memory_record', { kind: 'fact', title: `Background note ${index}`,
    content: `Unrelated archival note ${index} about the fixture.`, source: 'synthetic fixture', epistemic_status: 'observed' });
  store.close(); store = new Store(state); service = new Agentbase(store);
  const packet = await call('context_get', { task_id: task.id, query: 'invoice identity', max_chars: 1800 });
  report.metrics.context = { chars: packet.chars, max_chars: packet.max_chars, omitted_count: packet.omitted_count,
    included_count: packet.included_ids.length };
  check('Context stays within its budget and reports omissions', packet.chars <= 1800 && packet.omitted_count > 0);
  check('Superseded and forgotten memory stay out of context', !packet.included_ids.includes(old.id) && !packet.included_ids.includes(forgotten.id));
  const handoff = await call('handoff_get', { task_id: task.id, root });
  check('Fresh process retrieves the task and handoff', handoff.task?.id === task.id &&
    handoff.checkpoint?.body.next_action === 'Implement composite invoice identity.');
  report.status = report.checks.every(item => item.passed) ? 'passed' : 'failed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  store?.close();
  await rm(directory, { recursive: true, force: true });
  if (outputFlag) await writeFile(resolve(outputFlag.slice('--output='.length)), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
