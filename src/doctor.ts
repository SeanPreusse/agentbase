import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VERSION } from './version.js';

export async function doctor() {
  const directory = await mkdtemp(join(tmpdir(), 'agentbase-doctor-'));
  const checks: { name: string; status: 'passed' | 'failed' | 'unavailable'; detail: string }[] = [];
  let client: Client | undefined;
  try {
    const root = join(directory, 'project');
    await mkdir(root);
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../bin/agentbase.mjs', import.meta.url)), 'serve', '--home', join(directory, 'state')], stderr: 'pipe' });
    client = new Client({ name: 'agentbase-doctor', version: VERSION });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      checks.push({ name: 'stdio_mcp', status: 'passed', detail: `Connected to Agentbase ${client.getServerVersion()?.version}; ${tools.tools.length} tools available.` });
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client!.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
        if (result.isError) {
          const value = result.structuredContent as any;
          throw Object.assign(new Error(value?.message ?? JSON.stringify(result.content)), { code: value?.error });
        }
        return result.structuredContent as any;
      };
      const project = await call('project_open', { root });
      const base = { project_id: project.id, actor: 'doctor', request_id: 'doctor-task' };
      const task = await call('task_create', { ...base, title: 'Diagnostic task', description: 'Verify durable storage and retries.', acceptance: ['Retry returns the same task.'] });
      const retried = await call('task_create', { ...base, title: 'Diagnostic task', description: 'Verify durable storage and retries.', acceptance: ['Retry returns the same task.'] });
      if (task.id !== retried.id) throw new Error('Retry created a duplicate task.');
      checks.push({ name: 'storage_and_retries', status: 'passed', detail: 'Project state persisted and repeated request returned the same task.' });
      try {
        await writeFile(join(root, 'probe.csv'), 'value\n2\n3\n');
        const dataset = await call('dataset_import', { ...base, request_id: 'doctor-import', name: 'probe', path: 'probe.csv' });
        const analysis = await call('analysis_run', { ...base, request_id: 'doctor-analysis', title: 'Diagnostic sum', dataset_ids: [dataset.id], sql: 'SELECT sum(value) AS total FROM d1' });
        if (String(analysis.body.rows[0]?.[0]) !== '5') throw new Error('Unexpected DuckDB result.');
        checks.push({ name: 'sandboxed_analysis', status: 'passed', detail: 'Imported a temporary CSV and queried it through the OS-sandboxed DuckDB worker.' });
      } catch (error: any) {
        checks.push({ name: 'sandboxed_analysis', status: error.code === 'SANDBOX_UNAVAILABLE' ? 'unavailable' : 'failed', detail: error.message });
      }
    } catch (error: any) {
      checks.push({ name: 'core_mcp', status: 'failed', detail: error.message });
    }
    const core_ok = checks.some(c => c.name === 'storage_and_retries' && c.status === 'passed') && !checks.some(c => c.name !== 'sandboxed_analysis' && c.status === 'failed');
    const analysis_ok = checks.some(c => c.name === 'sandboxed_analysis' && c.status === 'passed');
    return { version: VERSION, node: process.versions.node, platform: `${process.platform}-${process.arch}`,
      status: !core_ok || checks.some(c => c.status === 'failed') ? 'failed' : analysis_ok ? 'passed' : 'degraded', core_ok, analysis_ok, checks };
  } finally { await client?.close(); await rm(directory, { recursive: true, force: true }); }
}
