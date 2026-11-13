import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installedPlugin } from './lib/plugin-installation.mjs';

const plugin = await installedPlugin();
const manifest = JSON.parse(await readFile(join(plugin.installedPath, 'mcp.json'), 'utf8')).mcpServers.agentbase;
const directory = await mkdtemp(join(tmpdir(), 'agentbase-project-test-'));
const root = join(directory, 'release'), otherRoot = join(directory, 'other-project'), state = join(directory, 'state');
const outputFlag = process.argv.find(arg => arg.startsWith('--output='));
const output = resolve(outputFlag?.slice(9) ?? 'test-results/project-management');
const clients = [];
const report = { status: 'running', plugin_version: plugin.version, synthetic_scenario: true, model_calls: 0, checks: [] };
let main;
async function connect() {
  const expand = value => value.replaceAll('${PLUGIN_ROOT}', plugin.installedPath);
  const transport = new StdioClientTransport({ command: manifest.command, args: manifest.args.map(expand), cwd: expand(manifest.cwd ?? plugin.installedPath),
    env: { ...getDefaultEnvironment(), AGENTBASE_HOME: state }, stderr: 'pipe' });
  const client = new Client({ name: 'project-management-validation', version: '1.0.0' });
  await client.connect(transport); clients.push(client); return client;
}
async function call(name, args, client = main) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    let error = result.structuredContent;
    if (!error) {
      const message = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      try { error = JSON.parse(message); } catch { error = { error: 'TOOL_ERROR', message }; }
    }
    throw Object.assign(new Error(error.message), { code: error.error });
  }
  return result.structuredContent;
}
async function check(name, fn) {
  try { await fn(); report.checks.push({ name, passed: true }); }
  catch (error) { report.checks.push({ name, passed: false, error: error.message }); }
  console.log(JSON.stringify(report.checks.at(-1)));
}
const evidence = [{ kind: 'manual', reference: 'synthetic-project-scenario', outcome: 'Synthetic acceptance evidence for exercising the task workflow; no production code change is claimed.' }];
try {
  await Promise.all([mkdir(root), mkdir(otherRoot), mkdir(output, { recursive: true })]);
  main = await connect();
  const second = await connect(), third = await connect();
  const project = await call('project_open', { root, name: 'Import reliability release', goal: 'Investigate, implement, and validate safe repeat imports.' });
  const other = await call('project_open', { root: otherRoot, name: 'Isolated project' });
  const read = id => call('record_get', { project_id: project.id, id });
  const write = (name, args, actor = 'planner', client = main) => call(name, { project_id: project.id, actor, request_id: randomUUID(), ...args }, client);
  let plan = await write('plan_save', { goal: project.goal, milestones: [
    { title: 'Investigate', acceptance: 'Record the root cause.' },
    { title: 'Implement', acceptance: 'Add a stable import identity.' },
    { title: 'Validate', acceptance: 'Repeated imports preserve expected rows.' },
  ], constraints: ['Keep state local.'] });
  const create = (title, args = {}) => write('task_create', { title, description: `Synthetic release task: ${title}`, acceptance: ['Supply completion evidence.'], plan_id: plan.id, ...args });
  const aInput = { request_id: 'diagnosis-once', title: 'Diagnose repeated imports', description: 'Synthetic release task: Diagnose repeated imports', acceptance: ['Supply completion evidence.'], plan_id: plan.id, priority: 1 };
  let a = await write('task_create', aInput);
  let b = await create('Implement import guard', { dependencies: [a.id], priority: 1 });
  let c = await create('Validate repeat imports', { dependencies: [b.id], priority: 0 });
  let proposal = await create('Optional checksum audit', { status: 'proposed', priority: 3 });
  let recovery = await create('Recover interrupted research', { priority: 4 });
  let cancelled = await create('Abandoned experiment', { priority: 4 });
  const dependent = await create('Depends on abandoned experiment', { dependencies: [cancelled.id], priority: 4 });
  recovery = await write('task_claim', { id: recovery.id, expected_version: recovery.version, lease_seconds: 30 }, 'abandoned-agent');
  const expiry = Date.parse(recovery.body.lease_expires_at);
  await check('Project discovery and stable identity', async () => {
    assert.equal((await call('project_open', { root })).id, project.id);
    const found = await call('project_list', { query: 'Import reliability' });
    assert.equal(found.total, 1); assert.equal(found.projects[0].id, project.id);
  });
  await check('Task retries do not duplicate work', async () => {
    assert.equal((await write('task_create', aInput)).id, a.id);
    assert.equal((await call('task_list', { project_id: project.id })).total, 7);
  });
  await check('Only unblocked approved tasks appear as ready', async () => {
    const ready = await call('task_list', { project_id: project.id, ready_only: true });
    assert.deepEqual(ready.records.map(t => t.id), [a.id, cancelled.id]);
    await assert.rejects(write('task_claim', { id: proposal.id, expected_version: 1 }), { code: 'TASK_NOT_READY' });
    await assert.rejects(write('task_claim', { id: b.id, expected_version: 1 }), { code: 'DEPENDENCIES_OPEN' });
  });
  await check('Dependency cycles are rejected without partial changes', async () => {
    await assert.rejects(write('task_update', { id: a.id, expected_version: 1, dependencies: [c.id] }), { code: 'DEPENDENCY_CYCLE' });
    assert.deepEqual((await read(a.id)).dependencies, []); assert.equal((await read(a.id)).version, 1);
  });
  await check('Cross-project reads and links are denied', async () => {
    await assert.rejects(call('record_get', { project_id: other.id, id: a.id }), { code: 'NOT_FOUND' });
    await assert.rejects(call('task_create', { project_id: other.id, actor: 'other', request_id: randomUUID(), title: 'Invalid foreign dependency', description: 'Must be rejected.', acceptance: ['Rejected'], dependencies: [a.id] }), { code: 'NOT_FOUND' });
    assert.equal((await call('task_list', { project_id: other.id })).total, 0);
  });
  const claims = await Promise.allSettled([
    write('task_claim', { id: a.id, expected_version: 1 }, 'agent-a', second),
    write('task_claim', { id: a.id, expected_version: 1 }, 'agent-b', third),
  ]);
  a = await read(a.id);
  const owner = a.body.owner, intruder = owner === 'agent-a' ? 'agent-b' : 'agent-a';
  await check('Competing agents produce exactly one owner', () => {
    assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(a.version, 2);
  });
  const previousExpiry = a.body.lease_expires_at;
  a = await write('task_claim', { id: a.id, expected_version: a.version, lease_seconds: 3600 }, owner);
  await check('The owner can renew a lease without transferring ownership', async () => {
    assert.equal(a.body.owner, owner); assert.ok(Date.parse(a.body.lease_expires_at) > Date.parse(previousExpiry));
    assert.equal((await read(a.id)).lease_active, true);
  });
  await check('Other agents cannot edit or finish owned work', async () => {
    await assert.rejects(write('task_update', { id: a.id, expected_version: a.version, title: 'Overwritten' }, intruder), { code: 'TASK_OWNED' });
    await assert.rejects(write('task_complete', { id: a.id, expected_version: a.version, summary: 'Not mine', evidence }, intruder), { code: 'LEASE_REQUIRED' });
    assert.equal((await read(a.id)).body.title, 'Diagnose repeated imports');
  });
  const session = await write('session_start', { client: 'installed-project-test', task_id: a.id }, owner);
  const checkpoint = await write('checkpoint_save', { session_id: session.id, task_id: a.id, summary: 'Diagnosis ready for review.', next_action: 'Review the diagnosis before implementing the guard.', task_progress: { expected_version: a.version, summary: 'Root cause recorded.' } }, owner);
  a = await read(a.id);
  await check('Checkpoint and task progress persist together', async () => {
    assert.equal(a.body.progress, 'Root cause recorded.');
    assert.equal((await call('handoff_get', { project_id: project.id, task_id: a.id })).checkpoint.id, checkpoint.id);
    const exportedBefore = await call('project_export', { project_id: project.id });
    await assert.rejects(write('checkpoint_save', { session_id: session.id, task_id: a.id, summary: 'Stale checkpoint', next_action: 'Must not persist.', task_progress: { expected_version: 1, summary: 'Stale write' } }, owner), { code: 'VERSION_CONFLICT' });
    const exportedAfter = await call('project_export', { project_id: project.id });
    assert.equal(exportedAfter.records.filter(r => r.kind === 'checkpoint').length, exportedBefore.records.filter(r => r.kind === 'checkpoint').length);
    assert.equal((await read(a.id)).body.progress, 'Root cause recorded.');
  });
  await check('Resume context explains prerequisite blockers', async () => {
    const context = await call('context_get', { project_id: project.id, task_id: b.id });
    await writeFile(join(output, 'blocked-task-context.json'), JSON.stringify(context, null, 2));
    assert.ok(context.content.includes(a.id), 'Blocked-task context omits its prerequisite task ID.');
    assert.match(context.content, /blockers/);
  });
  await check('Completion requires evidence and preserves status on rejection', async () => {
    await assert.rejects(write('task_complete', { id: a.id, expected_version: a.version, summary: 'No evidence' }, owner), { code: 'EVIDENCE_REQUIRED' });
    assert.equal((await read(a.id)).body.status, 'in_progress');
  });
  await check('Direct status edits cannot bypass the completion workflow', async () => {
    await assert.rejects(write('task_update', { id: a.id, expected_version: a.version, status: 'done', reason: 'Attempt to skip evidence.' }, owner));
    assert.equal((await read(a.id)).body.status, 'in_progress');
    assert.equal((await read(a.id)).version, a.version);
  });
  a = await write('task_update', { id: a.id, expected_version: a.version, status: 'review', reason: 'Investigation ready for review.' }, owner);
  a = await write('task_complete', { id: a.id, expected_version: a.version, summary: 'Synthetic diagnosis reviewed.', evidence }, owner);
  await check('Review and completion release dependent work', async () => {
    assert.equal(a.body.status, 'done'); assert.equal(a.body.owner, undefined);
    assert.equal(a.body.completion.verification, 'agent_reported');
    assert.ok((await call('task_list', { project_id: project.id, ready_only: true })).records.some(t => t.id === b.id));
    await assert.rejects(write('task_update', { id: a.id, expected_version: 1, title: 'Stale' }), { code: 'VERSION_CONFLICT' });
  });
  a = await write('task_update', { id: a.id, expected_version: a.version, status: 'ready', reason: 'A new reproduction reopened the investigation.' });
  await check('Reopening a prerequisite blocks downstream work again', async () => {
    assert.equal(a.body.completion, undefined);
    await assert.rejects(write('task_claim', { id: b.id, expected_version: b.version }), { code: 'DEPENDENCIES_OPEN' });
  });
  a = await write('task_claim', { id: a.id, expected_version: a.version }, owner);
  a = await write('task_complete', { id: a.id, expected_version: a.version, summary: 'Synthetic regression checked.', evidence }, owner);
  b = await write('task_claim', { id: b.id, expected_version: b.version }, 'builder');
  b = await write('task_update', { id: b.id, expected_version: b.version, status: 'blocked', reason: 'Waiting for the partner fixture.' }, 'builder');
  await check('Manual blockers release ownership and require explicit unblocking', async () => {
    assert.equal(b.body.owner, undefined);
    assert.ok((await call('task_list', { project_id: project.id, status: 'blocked' })).records.some(t => t.id === b.id));
    await assert.rejects(write('task_claim', { id: b.id, expected_version: b.version }), { code: 'TASK_NOT_READY' });
  });
  b = await write('task_update', { id: b.id, expected_version: b.version, status: 'ready', reason: 'Partner fixture available.' });
  b = await write('task_claim', { id: b.id, expected_version: b.version }, 'builder');
  const builderSession = await write('session_start', { client: 'builder', task_id: b.id }, 'builder');
  await write('checkpoint_save', { session_id: builderSession.id, task_id: b.id, summary: 'Guard ready for verification.', next_action: 'Finish the guard task and validate repeat imports.' }, 'builder');
  await Promise.all([main.close(), second.close(), third.close()]); main = await connect();
  await check('Cold restart resumes the correct task and plan', async () => {
    const context = await call('context_get', { project_id: project.id });
    assert.equal(context.selected_task_id, b.id); assert.ok(context.included_ids.includes(plan.id));
    assert.match(context.content, /Finish the guard task/);
  });
  b = await write('task_complete', { id: b.id, expected_version: b.version, summary: 'Synthetic guard acceptance satisfied.', evidence }, 'builder');
  c = await write('task_claim', { id: c.id, expected_version: c.version }, 'tester');
  c = await write('task_complete', { id: c.id, expected_version: c.version, summary: 'Synthetic repeat-import validation complete.', evidence }, 'tester');
  await check('The dependency chain completes in order', () => assert.ok([a, b, c].every(t => t.body.status === 'done')));
  proposal = await write('task_update', { id: proposal.id, expected_version: proposal.version, status: 'ready', reason: 'Proposal explicitly accepted.' });
  proposal = await write('task_update', { id: proposal.id, expected_version: proposal.version, status: 'cancelled', reason: 'Deferred from this release.' });
  cancelled = await write('task_update', { id: cancelled.id, expected_version: cancelled.version, status: 'cancelled', reason: 'Experiment abandoned.' });
  await check('Cancelled dependencies do not count as completed', async () => {
    await assert.rejects(write('task_claim', { id: dependent.id, expected_version: 1 }), { code: 'DEPENDENCIES_OPEN' });
    assert.ok((await read(dependent.id)).dependencies.includes(cancelled.id));
    assert.equal(proposal.body.status, 'cancelled');
  });
  plan = await write('plan_save', { id: plan.id, expected_version: plan.version, ...plan.body, constraints: [...plan.body.constraints, 'Keep optional audit out of the release.'] });
  await check('Plan revisions preserve task links and reject stale edits', async () => {
    assert.equal((await read(b.id)).body.plan_id, plan.id);
    await assert.rejects(write('plan_save', { id: plan.id, expected_version: 1, ...plan.body }), { code: 'VERSION_CONFLICT' });
    assert.equal((await read(plan.id)).version, 2);
  });
  await check('Pagination and project search remain consistent', async () => {
    const pages = await Promise.all([0, 3, 6].map(offset => call('task_list', { project_id: project.id, offset, limit: 3 })));
    const ids = pages.flatMap(p => p.records.map(t => t.id));
    assert.equal(ids.length, 7); assert.equal(new Set(ids).size, 7);
    assert.equal((await call('search', { project_id: other.id, query: 'import' })).records.length, 0);
  });
  const wait = Math.max(0, expiry - Date.now() + 100);
  console.log(JSON.stringify({ phase: 'real_lease_expiry', waiting_seconds: Math.ceil(wait / 1000) }));
  await new Promise(resolve => setTimeout(resolve, wait));
  await check('Expired ownership is discoverable and reclaimable by another agent', async () => {
    const ready = await call('task_list', { project_id: project.id, ready_only: true });
    assert.ok(ready.records.some(t => t.id === recovery.id && t.reclaimable));
    recovery = await write('task_claim', { id: recovery.id, expected_version: recovery.version }, 'rescue-agent');
    assert.equal(recovery.body.owner, 'rescue-agent');
  });
  recovery = await write('task_complete', { id: recovery.id, expected_version: recovery.version, summary: 'Synthetic interrupted research recovered.', evidence }, 'rescue-agent');
  const exported = await call('project_export', { project_id: project.id });
  await check('Audit and exported relationships explain the project state', () => {
    assert.ok(exported.events.some(e => e.action === 'completed' && e.record_id === c.id));
    assert.ok(exported.dependencies.some(d => d.task_id === b.id && d.depends_on === a.id));
    assert.ok(exported.links.some(l => l.source_id === b.id && l.target_id === plan.id));
    assert.ok(exported.records.every(r => r.project_id === project.id));
  });
  const tasks = (await call('task_list', { project_id: project.id, limit: 100 })).records;
  report.final_tasks = tasks.map(t => ({ title: t.body.title, status: t.body.status, priority: t.body.priority, blockers: t.blockers.length, lease_active: t.lease_active }));
  report.final_counts = tasks.reduce((counts, t) => ({ ...counts, [t.body.status]: (counts[t.body.status] ?? 0) + 1 }), {});
  report.dependency_blocked_tasks = tasks.filter(t => t.blockers.length > 0 && !['done', 'cancelled'].includes(t.body.status)).length;
  report.ready_to_claim = (await call('task_list', { project_id: project.id, ready_only: true })).total;
  report.project_goal = project.goal; report.plan_revision = plan.version;
  report.status = report.checks.every(c => c.passed) ? 'passed' : 'failed';
  await writeFile(join(output, 'project.json'), JSON.stringify(exported, null, 2) + '\n');
} catch (error) { report.status = 'error'; report.error = error.message; }
finally {
  await Promise.allSettled(clients.map(client => client.close()));
  await rm(directory, { recursive: true, force: true });
  report.temporary_store_removed = true;
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
