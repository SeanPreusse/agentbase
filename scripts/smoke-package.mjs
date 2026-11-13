import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'agentbase-package-'));
let client;
try {
  const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: resolve('.'), maxBuffer: 8 * 1024 * 1024 });
  const archive = JSON.parse(stdout)[0];
  await exec('tar', ['-xzf', join(directory, archive.filename), '-C', directory]);
  const projectRoot = join(directory, 'project'); await mkdir(projectRoot);
  await writeFile(join(projectRoot, 'sample.csv'), 'value\n2\n3\n');
  client = new Client({ name: 'package-smoke', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(directory, 'package/bin/agentbase.mjs'), 'serve', '--home', join(directory, 'state')], stderr: 'pipe', cwd: directory }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent;
  };
  const project = await call('project_open', { root: projectRoot });
  const dataset = await call('dataset_import', { project_id: project.id, actor: 'package-test', request_id: 'import', path: 'sample.csv', name: 'sample' });
  const analysis = await call('analysis_run', { project_id: project.id, actor: 'package-test', request_id: 'query', title: 'Packaged sum', dataset_ids: [dataset.id], sql: 'SELECT sum(value) AS total FROM d1' });
  assert.equal(String(analysis.body.rows[0][0]), '5');
  console.log(`Packaged MCP and sandboxed DuckDB passed (${archive.filename}, ${archive.size} bytes).`);
} finally { await client?.close(); await rm(directory, { recursive: true, force: true }); }
