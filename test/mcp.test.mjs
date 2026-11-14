import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
  assert.equal(tools.tools.length, 32);
  for (const name of ['skill_save', 'skill_list', 'skill_recommend']) assert.ok(tools.tools.some(tool => tool.name === name));
  const projectResult = await client.callTool({ name: 'project_open', arguments: { root } });
  const project = projectResult.structuredContent;
  const discovered = await client.callTool({ name: 'project_list', arguments: { query: project.id } });
  assert.equal(discovered.structuredContent.projects[0].id, project.id);
  const taskResult = await client.callTool({ name: 'task_create', arguments: { project_id: project.id, actor: 'a', request_id: 'once',
    title: 'Persistent task', description: 'Verify MCP persistence.', acceptance: ['Fresh session reads the task.'] } });
  assert.equal(taskResult.isError, undefined);
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
