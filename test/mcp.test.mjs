import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { schemas } from '../dist/schemas.js';
import { outputSchemas, toolAnnotations } from '../dist/server.js';

test('real stdio MCP exposes tools, validates input, and survives errors across sessions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbase-mcp-'));
  const root = join(directory, 'project'); await mkdir(root);
  const home = join(directory, 'state');
  const open = async () => {
    const client = new Client({ name: 'agentbase-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('bin/agentbase.mjs'), 'serve', '--home', home], stderr: 'pipe' });
    await client.connect(transport);
    return client;
  };
  let client = await open();
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), Object.keys(schemas).sort());
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), Object.keys(outputSchemas).sort());
  assert.equal(tools.tools.length, Object.keys(schemas).length);
  const readOnly = new Set(['mcp_status', 'graph_get', 'backup_verify', 'project_list', 'record_get', 'search', 'task_list',
    'handoff_get', 'context_get', 'dataset_inspect', 'project_export', 'skill_list', 'skill_recommend']);
  const destructive = new Set(['project_attach', 'knowledge_save', 'graph_link', 'skill_save', 'plan_save', 'task_update', 'task_claim',
    'task_complete', 'memory_record', 'memory_update', 'checkpoint_save']);
  for (const tool of tools.tools) {
    assert.deepEqual(tool.annotations, toolAnnotations(tool.name));
    assert.equal(tool.annotations.readOnlyHint, readOnly.has(tool.name), `${tool.name} read-only hint must match behavior`);
    if (readOnly.has(tool.name)) {
      assert.equal('idempotentHint' in tool.annotations, false, 'Idempotency is not meaningful for read-only tools');
      assert.equal('destructiveHint' in tool.annotations, false, 'Destructiveness is not meaningful for read-only tools');
    } else {
      assert.equal(tool.annotations.destructiveHint, destructive.has(tool.name), `${tool.name} destructive hint must match behavior`);
      assert.equal(tool.annotations.idempotentHint, true, `${tool.name} retry behavior must be idempotent`);
    }
    assert.ok(tool.outputSchema, `${tool.name} must publish its real output schema`);
    assert.ok(Object.keys(tool.outputSchema.properties ?? {}).length > 0, `${tool.name} output schema must declare fields`);
  }
  for (const name of ['mcp_status', 'skill_save', 'skill_list', 'skill_recommend']) assert.ok(tools.tools.some(tool => tool.name === name));
  assert.deepEqual(tools.tools.find(tool => tool.name === 'mcp_status').annotations,
    { readOnlyHint: true, openWorldHint: false });
  assert.equal(tools.tools.find(tool => tool.name === 'mcp_status').title, 'MCP Status');
  assert.equal(tools.tools.find(tool => tool.name === 'task_complete').title, 'Task Complete');
  assert.equal(tools.tools.find(tool => tool.name === 'project_restore').annotations.destructiveHint, false);
  assert.equal(tools.tools.find(tool => tool.name === 'project_restore').annotations.idempotentHint, true);
  assert.equal(tools.tools.find(tool => tool.name === 'memory_update').annotations.destructiveHint, true);
  const projectResult = await client.callTool({ name: 'project_open', arguments: { root } });
  const project = projectResult.structuredContent;
  const status = await client.callTool({ name: 'mcp_status', arguments: { project_id: project.id } });
  assert.equal(status.structuredContent.status, 'ready');
  assert.equal(status.structuredContent.project.available, true);
  assert.equal(status.structuredContent.storage.search_index_available, true);
  assert.equal(status.structuredContent.sandbox.status, 'not_probed');
  const projectRetry = await client.callTool({ name: 'project_open', arguments: { root } });
  assert.equal(projectRetry.structuredContent.id, project.id);
  const discovered = await client.callTool({ name: 'project_list', arguments: { query: project.id } });
  assert.equal(discovered.structuredContent.projects[0].id, project.id);
  const taskResult = await client.callTool({ name: 'task_create', arguments: { project_id: project.id, actor: 'a', request_id: 'once',
    title: 'Persistent task', description: 'Verify MCP persistence.', acceptance: ['Fresh session reads the task.'] } });
  assert.equal(taskResult.isError, undefined);
  const taskRetry = await client.callTool({ name: 'task_create', arguments: { project_id: project.id, actor: 'a', request_id: 'once',
    title: 'Persistent task', description: 'Verify MCP persistence.', acceptance: ['Fresh session reads the task.'] } });
  assert.equal(taskRetry.structuredContent.id, taskResult.structuredContent.id);
  const skillResult = await client.callTool({ name: 'skill_save', arguments: { project_id: project.id, actor: 'a', request_id: 'skill-once',
    title: 'MCP persistence helper', description: 'Verify MCP continuity.', triggers: ['MCP persistence'], source: '/project/skills/persistence/SKILL.md' } });
  assert.equal(skillResult.isError, undefined);
  const recommended = await client.callTool({ name: 'skill_recommend', arguments: { project_id: project.id, task_id: taskResult.structuredContent.id } });
  assert.equal(recommended.structuredContent.recommendations[0].id, skillResult.structuredContent.id);
  const resumed = await client.callTool({ name: 'project_resume', arguments: { root, task_id: taskResult.structuredContent.id } });
  assert.equal(resumed.structuredContent.project.id, project.id);
  assert.equal(resumed.structuredContent.project.working_root, project.working_root);
  assert.equal(resumed.structuredContent.selected_task_id, taskResult.structuredContent.id);
  assert.equal(resumed.structuredContent.open_task_count, 1);
  assert.equal(resumed.structuredContent.open_tasks[0].id, taskResult.structuredContent.id);
  const otherRoot = join(directory, 'other'); await mkdir(otherRoot);
  const otherResume = await client.callTool({ name: 'project_resume', arguments: { root: otherRoot } });
  assert.notEqual(otherResume.structuredContent.project.id, project.id);
  assert.equal(otherResume.structuredContent.selected_task_id, null);
  const attachedRoot = join(directory, 'attached'); await mkdir(attachedRoot);
  const attached = await client.callTool({ name: 'project_attach', arguments: { project_id: project.id, actor: 'a', request_id: 'attach-once',
    root: attachedRoot, reason: 'Exercise attached worktree response.' } });
  assert.equal(attached.isError, undefined);
  const context = await client.callTool({ name: 'context_get', arguments: { project_id: project.id, task_id: taskResult.structuredContent.id } });
  assert.equal(context.isError, undefined);
  const handoff = await client.callTool({ name: 'handoff_get', arguments: { project_id: project.id, task_id: taskResult.structuredContent.id, root } });
  assert.equal(handoff.isError, undefined);
  const graph = await client.callTool({ name: 'graph_get', arguments: { project_id: project.id, focus_id: taskResult.structuredContent.id } });
  assert.equal(graph.isError, undefined);
  const conceptA = await client.callTool({ name: 'knowledge_save', arguments: { project_id: project.id, actor: 'a', request_id: 'concept-a',
    node_type: 'concept', title: 'MCP contract', content: 'A verified protocol result.', source: 'test/mcp.test.mjs', epistemic_status: 'observed' } });
  const conceptB = await client.callTool({ name: 'knowledge_save', arguments: { project_id: project.id, actor: 'a', request_id: 'concept-b',
    node_type: 'concept', title: 'MCP consumer', content: 'A client uses the protocol.', source: 'test/mcp.test.mjs', epistemic_status: 'observed' } });
  const linked = await client.callTool({ name: 'graph_link', arguments: { project_id: project.id, actor: 'a', request_id: 'concept-link',
    source_id: conceptA.structuredContent.id, target_id: conceptB.structuredContent.id, expected_version: conceptA.structuredContent.version } });
  assert.equal(linked.isError, undefined);
  const searched = await client.callTool({ name: 'search', arguments: { project_id: project.id, query: 'Persistent task' } });
  assert.ok(searched.structuredContent.records.length > 0);
  const fetched = await client.callTool({ name: 'record_get', arguments: { project_id: project.id, id: taskResult.structuredContent.id } });
  assert.equal(fetched.isError, undefined);
  const exported = await client.callTool({ name: 'project_export', arguments: { project_id: project.id } });
  assert.equal(exported.isError, undefined);
  const fact = await client.callTool({ name: 'memory_record', arguments: { project_id: project.id, actor: 'a', request_id: 'fact-once', kind: 'fact',
    title: 'MCP contract', content: 'Responses are validated through stdio.', source: 'test/mcp.test.mjs', epistemic_status: 'observed' } });
  assert.equal(fact.isError, undefined);
  const updatedFact = await client.callTool({ name: 'memory_update', arguments: { project_id: project.id, actor: 'a', request_id: 'fact-stale',
    id: fact.structuredContent.id, expected_version: fact.structuredContent.version, status: 'stale', reason: 'Test update.' } });
  assert.equal(updatedFact.isError, undefined);
  const staleRetry = await client.callTool({ name: 'memory_update', arguments: { project_id: project.id, actor: 'a', request_id: 'fact-stale',
    id: fact.structuredContent.id, expected_version: fact.structuredContent.version, status: 'stale', reason: 'Test update.' } });
  assert.equal(staleRetry.structuredContent.version, updatedFact.structuredContent.version);
  const plan = await client.callTool({ name: 'plan_save', arguments: { project_id: project.id, actor: 'a', request_id: 'plan-once', goal: 'Verify MCP output contracts.',
    milestones: [{ title: 'Exercise stdio', acceptance: 'A real MCP client reads the results.' }] } });
  assert.equal(plan.isError, undefined);
  const session = await client.callTool({ name: 'session_start', arguments: { project_id: project.id, actor: 'a', client: 'stdio test', request_id: 'session-once', root } });
  assert.equal(session.isError, undefined);
  const checkpoint = await client.callTool({ name: 'checkpoint_save', arguments: { project_id: project.id, actor: 'a', request_id: 'checkpoint-once',
    session_id: session.structuredContent.id, summary: 'MCP schema contract run.', next_action: 'Complete integration check.' } });
  assert.equal(checkpoint.isError, undefined);
  const invalid = await client.callTool({ name: 'task_create', arguments: { project_id: project.id } });
  assert.equal(invalid.isError, true);
  await client.close(); client = await open();
  const tasks = await client.callTool({ name: 'task_list', arguments: { project_id: project.id } });
  assert.equal(tasks.structuredContent.records.length, 1);
  assert.equal(tasks.structuredContent.records[0].body.title, 'Persistent task');
  const skills = await client.callTool({ name: 'skill_list', arguments: { project_id: project.id } });
  assert.equal(skills.structuredContent.total, 1);
  assert.equal(skills.structuredContent.records[0].body.title, 'MCP persistence helper');
  const missing = await client.callTool({ name: 'record_get', arguments: { project_id: project.id, id: 'missing' } });
  assert.equal(missing.isError, true); assert.equal(missing.structuredContent.error, 'NOT_FOUND');
  assert.match(missing.structuredContent.recovery, /search, project_list, or project_open/);
  const updatedTask = await client.callTool({ name: 'task_update', arguments: { project_id: project.id, actor: 'a', request_id: 'task-update',
    id: taskResult.structuredContent.id, expected_version: taskResult.structuredContent.version, title: 'Persistent MCP task' } });
  assert.equal(updatedTask.isError, undefined);
  const claimed = await client.callTool({ name: 'task_claim', arguments: { project_id: project.id, actor: 'a', request_id: 'task-claim',
    id: updatedTask.structuredContent.id, expected_version: updatedTask.structuredContent.version } });
  assert.equal(claimed.isError, undefined);
  const completed = await client.callTool({ name: 'task_complete', arguments: { project_id: project.id, actor: 'a', request_id: 'task-complete',
    id: claimed.structuredContent.id, expected_version: claimed.structuredContent.version, summary: 'Validated over stdio.',
    evidence: [{ kind: 'manual', reference: 'test/mcp.test.mjs', outcome: 'Real client calls returned structured results.' }] } });
  assert.equal(completed.isError, undefined);
  const csv = join(root, 'measurements.csv'); await writeFile(csv, 'value\n2\n3\n');
  const dataset = await client.callTool({ name: 'dataset_import', arguments: { project_id: project.id, actor: 'a', request_id: 'dataset-once', name: 'measurements', path: csv } });
  if (dataset.isError) {
    assert.equal(dataset.structuredContent.error, 'SANDBOX_UNAVAILABLE', 'Only a real unavailable sandbox may skip DuckDB result paths');
    t.diagnostic('DuckDB analysis output paths not exercised because the current host has no supported OS sandbox.');
  } else {
    const inspected = await client.callTool({ name: 'dataset_inspect', arguments: { project_id: project.id, id: dataset.structuredContent.id } });
    assert.equal(inspected.isError, undefined);
    const analysis = await client.callTool({ name: 'analysis_run', arguments: { project_id: project.id, actor: 'a', request_id: 'analysis-once', title: 'Sum values',
      dataset_ids: [dataset.structuredContent.id], sql: 'SELECT sum(value) AS total FROM d1' } });
    assert.equal(analysis.isError, undefined);
    const artifact = await client.callTool({ name: 'artifact_export', arguments: { project_id: project.id, analysis_id: analysis.structuredContent.id, format: 'csv' } });
    assert.equal(artifact.isError, undefined);
    const artifactRetry = await client.callTool({ name: 'artifact_export', arguments: { project_id: project.id, analysis_id: analysis.structuredContent.id, format: 'csv' } });
    assert.equal(artifactRetry.structuredContent.path, artifact.structuredContent.path);
  }
  const backupPath = join(directory, 'backup');
  const backupArgs = { project_id: project.id, actor: 'a', request_id: 'backup-once', destination: backupPath };
  const backup = await client.callTool({ name: 'project_backup', arguments: backupArgs });
  assert.equal(backup.isError, undefined, JSON.stringify(backup.structuredContent));
  const backupRetry = await client.callTool({ name: 'project_backup', arguments: backupArgs });
  assert.equal(backupRetry.structuredContent.backup_id, backup.structuredContent.backup_id);
  const verified = await client.callTool({ name: 'backup_verify', arguments: { backup_path: backupPath } });
  assert.equal(verified.structuredContent.valid, true);
  const restoreRoot = join(directory, 'restored-project'); await mkdir(restoreRoot);
  const restoreHome = join(directory, 'restored-state');
  const restoreClient = new Client({ name: 'agentbase-restore-test', version: '1.0.0' });
  await restoreClient.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('bin/agentbase.mjs'), 'serve', '--home', restoreHome], stderr: 'pipe' }));
  t.after(async () => { await restoreClient.close(); });
  const restoreArgs = { backup_path: backupPath, root: restoreRoot, actor: 'a', request_id: 'restore-once' };
  const restored = await restoreClient.callTool({ name: 'project_restore', arguments: restoreArgs });
  assert.equal(restored.isError, undefined);
  assert.equal(restored.structuredContent.restored, true);
  const restoreRetry = await restoreClient.callTool({ name: 'project_restore', arguments: restoreArgs });
  assert.equal(restoreRetry.structuredContent.project_id, restored.structuredContent.project_id);
});

test('plugin launcher finds a supported Node when the GUI PATH has no node', async t => {
  const directory=await mkdtemp(join(tmpdir(),'agentbase-launcher-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const client=new Client({name:'agentbase-launcher-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:'/bin/sh',args:[resolve('bin/agentbase-launch.sh')],
    env:{HOME:homedir(),PATH:'/usr/bin:/bin',AGENTBASE_NODE:process.execPath,AGENTBASE_HOME:join(directory,'state')},stderr:'pipe'});
  await client.connect(transport);
  t.after(()=>client.close());
  assert.ok((await client.listTools()).tools.some(tool=>tool.name==='task_create'));
});
