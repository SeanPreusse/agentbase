import { DuckDBInstance, StatementType, version } from '@duckdb/node-api';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type WorkerInput } from './analysis.js';

async function main(input: WorkerInput & { scratch: string }) {
  const instance = await DuckDBInstance.create(':memory:', {
    threads: '2', memory_limit: '256MB', max_temp_directory_size: '64MB',
    temp_directory: input.scratch, autoinstall_known_extensions: 'false', autoload_known_extensions: 'false',
  });
  const connection = await instance.connect();
  const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  const schema = (reader: any) => reader.columnNames().map((name: string, i: number) => ({ name, type: String(reader.columnType(i)) }));
  try {
    for (const [i, dataset] of input.datasets.entries()) {
      const bytes = await readFile(dataset.path);
      if (createHash('sha256').update(bytes).digest('hex') !== dataset.hash) throw new Error('Dataset snapshot integrity check failed. Reimport the source file.');
      const reader = dataset.extension === '.csv' ? 'read_csv_auto' : dataset.extension === '.parquet' ? 'read_parquet' : 'read_json_auto';
      await connection.run(`CREATE TABLE d${i + 1} AS SELECT * FROM ${reader}(${literal(dataset.path)})`);
    }
    // Trusted ingestion is finished. User SQL sees only in-memory snapshots.
    await connection.run("SET enable_external_access=false; SET allow_community_extensions=false; SET lock_configuration=true;");
    if (input.mode === 'inspect') {
      const sample = await connection.runAndReadAll('SELECT * FROM d1 LIMIT 5');
      const count = await connection.runAndReadAll('SELECT count(*) AS n FROM d1');
      return { schema: schema(sample), rows: sample.getRowsJson(), row_count: String(count.getRows()[0]?.[0]), engine: version() };
    }
    const statements = await connection.extractStatements(input.sql!);
    if (statements.count !== 1) throw new Error('Supply exactly one SELECT query. Multiple statements are not allowed.');
    const statement = await statements.prepare(0);
    try {
      if (statement.statementType !== StatementType.SELECT) throw new Error('Only SELECT queries (including WITH) are allowed.');
      // Stream and stop after one extra row; never materialize an unbounded result in JS.
      const result = await statement.streamAndReadUntil(input.max_rows + 1);
      const rows = result.getRowsJson();
      return { schema: schema(result), rows: rows.slice(0, input.max_rows), truncated: rows.length > input.max_rows, engine: version() };
    } finally { statement.destroySync(); }
  } finally { connection.closeSync(); instance.closeSync(); }
}

let payload = '';
for await (const chunk of process.stdin) {
  payload += chunk;
  if (payload.length > 100000) throw new Error('Worker payload exceeds limit.');
}
try { process.stdout.write(JSON.stringify(await main(JSON.parse(payload)))); }
catch (error: any) { process.stdout.write(JSON.stringify({ error: error.message, code: 'ANALYSIS_FAILED' })); }
