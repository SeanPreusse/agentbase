import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../dist/store.js';
import { Agentbase } from '../dist/service.js';
import { runAnalysisWorker } from '../dist/analysis.js';
import { sandboxCommand } from '../dist/analysis.js';
import { spawnSync } from 'node:child_process';
import { DuckDBInstance } from '@duckdb/node-api';
import { createServer } from 'node:net';

test('immutable CSV analysis, joins, provenance, exports and rejected SQL', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbase-data-'));
  const root = join(directory, 'project'); await mkdir(root);
  const store = new Store(join(directory, 'state'));
  const service = new Agentbase(store);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const project = await service.call('project_open', { root });
  const call = (tool, args = {}) => service.call(tool, { project_id: project.id, actor: 'analyst', request_id: randomUUID(), ...args });
  const path = join(root, 'errors.csv');
  await writeFile(path, 'service,errors\nimports,5\nexports,2\nimports,3\n');
  const dataset = await call('dataset_import', { path, name: 'errors' });
  assert.equal(dataset.body.row_count, '3');
  assert.deepEqual(dataset.body.schema.map(c => c.name), ['service', 'errors']);
  await writeFile(path, 'service,errors\nimports,100\n');
  const analysis = await call('analysis_run', { title: 'Error totals', dataset_ids: [dataset.id],
    sql: 'WITH totals AS (SELECT service, sum(errors) AS errors FROM d1 GROUP BY service) SELECT * FROM totals ORDER BY errors DESC' });
  assert.equal(analysis.body.rows[0][0], 'imports'); assert.equal(String(analysis.body.rows[0][1]), '8');
  assert.equal(analysis.body.datasets[0].sha256, dataset.body.sha256);
  assert.match(analysis.body.engine, /v?2\./);
  const exported = await service.call('artifact_export', { project_id: project.id, analysis_id: analysis.id, format: 'csv' });
  assert.match(await readFile(exported.path, 'utf8'), /"imports","8"/);
  const second = await call('dataset_import', { path, name: 'errors' });
  assert.equal(second.body.dataset_version, 2); assert.equal(second.body.previous_version_id, dataset.id);
  // Retrying the import is independent of subsequent changes to its original source.
  const retryInput = { path, name: 'retry-data', request_id: 'retry-import' };
  const once = await call('dataset_import', retryInput);
  await rm(path);
  assert.equal((await call('dataset_import', retryInput)).id, once.id);
  const joined = await call('analysis_run', { title: 'Compare', dataset_ids: [dataset.id, second.id], sql: 'SELECT sum(a.errors) AS old_errors, max(b.errors) AS new_errors FROM d1 a JOIN d2 b USING(service)' });
  assert.deepEqual(joined.body.rows[0].map(String), ['8', '100']);
  const truncated = await call('analysis_run', { title: 'Preview', dataset_ids: [dataset.id], sql: 'SELECT * FROM d1', max_rows: 1 });
  assert.equal(truncated.body.truncated, true); assert.equal(truncated.body.rows.length, 1);
  for (const sql of [
    'SELECT 1; SELECT 2', 'DELETE FROM d1', "COPY d1 TO '/tmp/agentbase-should-not-exist.csv'",
    "SELECT * FROM read_csv('/etc/passwd')", "SELECT * FROM read_text('https://example.com/')", 'INSTALL httpfs',
  ]) await assert.rejects(call('analysis_run', { title: 'Denied query', dataset_ids: [dataset.id], sql }), { code: 'ANALYSIS_FAILED' });
  const external = join(directory, 'private.csv'); await writeFile(external, 'a\n1\n');
  await assert.rejects(call('dataset_import', { path: external, name: 'external' }), { code: 'PATH_DENIED' });
  await symlink(external, join(root, 'escape.csv'));
  await assert.rejects(call('dataset_import', { path: join(root, 'escape.csv'), name: 'external' }), { code: 'PATH_DENIED' });
  await writeFile(dataset.body.snapshot, 'corrupt');
  await assert.rejects(call('analysis_run', { title: 'Integrity', dataset_ids: [dataset.id], sql: 'SELECT * FROM d1' }), /integrity/);
});

test('OS sandbox denies unrelated file reads, external writes, and subprocess execution', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbase-sandbox-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const allowed = join(directory, 'allowed.csv'), denied = join(directory, 'secret.txt');
  const scratch = join(directory, 'scratch'); await mkdir(scratch);
  await writeFile(allowed, 'value\n1\n'); await writeFile(denied, 'PRIVATE');
  const server = createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const launch = await sandboxCommand(process.execPath, 'unused', [allowed], scratch);
  const code = `
    const fs=require('node:fs');
    const assert=require('node:assert/strict');
    assert.match(fs.readFileSync(${JSON.stringify(allowed)},'utf8'), /value/);
    assert.throws(()=>fs.readFileSync(${JSON.stringify(denied)},'utf8'));
    assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(directory, 'escaped.txt'))},'bad'));
    const result=require('node:child_process').spawnSync('/bin/sh',['-c','echo escaped']);
    assert.notEqual(result.status,0);
    const socket=require('node:net').connect({host:'127.0.0.1',port:${port}});
    socket.on('connect',()=>{console.error('Network escaped');process.exit(1)});
    socket.on('error',()=>{socket.destroy();console.log('isolated')});
  `;
  const result = spawnSync(launch.command, [...launch.args.slice(0, -1), '-e', code], { encoding: 'utf8', cwd: scratch, timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: scratch } });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /isolated/);
});

test('Parquet snapshots preserve typed columns', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbase-parquet-'));
  const root = join(directory, 'project'); await mkdir(root);
  const store = new Store(join(directory, 'state')); const service = new Agentbase(store);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const instance = await DuckDBInstance.create(':memory:'); const connection = await instance.connect();
  const path = join(root, 'input.parquet');
  try { await connection.run(`COPY (SELECT 42::INTEGER AS answer, DATE '2026-11-12' AS day) TO '${path.replaceAll("'", "''")}' (FORMAT PARQUET)`); }
  finally { connection.closeSync(); instance.closeSync(); }
  const project = await service.call('project_open', { root });
  const dataset = await service.call('dataset_import', { project_id: project.id, actor: 'a', request_id: randomUUID(), path, name: 'typed' });
  assert.equal(dataset.body.schema[0].type, 'INTEGER'); assert.equal(dataset.body.schema[1].type, 'DATE');
  assert.deepEqual(dataset.body.sample[0], [42, '2026-11-12']);
});

test('JSON data imports and queries exceeding runtime are killed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbase-json-'));
  const root = join(directory, 'project'); await mkdir(root);
  const store = new Store(join(directory, 'state'));
  const service = new Agentbase(store);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const project = await service.call('project_open', { root });
  const path = join(root, 'data.json'); await writeFile(path, '[{"value":3},{"value":7}]');
  const dataset = await service.call('dataset_import', { project_id: project.id, actor: 'a', request_id: randomUUID(), path, name: 'numbers' });
  assert.equal(dataset.body.row_count, '2');
  await assert.rejects(runAnalysisWorker({ mode: 'query', datasets: [{ path: dataset.body.snapshot, extension: '.json', hash: dataset.body.sha256 }],
    sql: 'SELECT sum(sin(i)) FROM range(1000000000000) AS r(i)', max_rows: 1 }, 1000), { code: 'ANALYSIS_TIMEOUT' });
});
