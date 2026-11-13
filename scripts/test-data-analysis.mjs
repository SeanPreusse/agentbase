import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installedPlugin } from './lib/plugin-installation.mjs';

const plugin = await installedPlugin();
const manifest = JSON.parse(await readFile(join(plugin.installedPath, 'mcp.json'), 'utf8')).mcpServers.agentbase;
const directory = await mkdtemp(join(tmpdir(), 'agentbase-analysis-'));
const root = join(directory, 'project'), state = join(directory, 'state');
const output = resolve('test-results/data-analysis');
const regions = ['East', 'North', 'South', 'West'];
const customers = Array.from({ length: 120 }, (_, i) => ({ customer_id: i + 1, region: regions[i % regions.length] }));
const orders = Array.from({ length: 10000 }, (_, i) => {
  const id = i + 1;
  return { order_id: id, customer_id: id % 211 === 0 ? 999999 : id % 173 === 0 ? null : (id * 17) % customers.length + 1,
    order_date: new Date(Date.UTC(2026, 0, 1 + (id * 7) % 90)).toISOString().slice(0, 10),
    quantity: id % 5 + 1, unit_price_cents: 995 + (id % 23) * 125, discount_cents: id % 7 === 0 ? 200 : 0,
    status: id % 19 === 0 ? 'cancelled' : id % 13 === 0 ? 'refunded' : 'completed' };
});
const rawOrders = [...orders, ...orders.slice(0, 5)];
const monthly = new Map(), regional = new Map(), byCustomer = new Map();
let revenue = 0, completed = 0;
for (const row of orders) {
  if (row.status !== 'completed') continue;
  const cents = row.quantity * row.unit_price_cents - row.discount_cents;
  const month = row.order_date.slice(0, 7) + '-01';
  const region = customers.find(c => c.customer_id === row.customer_id)?.region ?? 'Unmatched';
  for (const [map, key] of [[monthly, month], [regional, region]]) {
    const item = map.get(key) ?? { orders: 0, cents: 0 };
    item.orders++; item.cents += cents; map.set(key, item);
  }
  if (region !== 'Unmatched') byCustomer.set(row.customer_id, (byCustomer.get(row.customer_id) ?? 0) + cents);
  revenue += cents; completed++;
}
const deduplicated = 'SELECT * FROM d1 QUALIFY row_number() OVER (PARTITION BY order_id ORDER BY order_id) = 1';
const monthlySql = `WITH clean AS (${deduplicated})
  SELECT date_trunc('month', order_date)::DATE AS month, count(*) AS completed_orders,
         sum(quantity * unit_price_cents - discount_cents) AS revenue_cents
  FROM clean WHERE status='completed' GROUP BY 1 ORDER BY 1`;
const regionSql = `WITH clean AS (${deduplicated})
  SELECT coalesce(c.region,'Unmatched') AS region, count(*) AS completed_orders,
         sum(o.quantity * o.unit_price_cents - o.discount_cents) AS revenue_cents
  FROM clean o LEFT JOIN d2 c USING(customer_id)
  WHERE o.status='completed' GROUP BY 1 ORDER BY 1`;
const checks = [];
let connection;
let report;
const normalize = rows => rows.map(row => row.map(v => v === null ? null : String(v)));
const checked = (name, actual, expected) => {
  assert.deepEqual(normalize(actual), normalize(expected), name);
  checks.push({ name, passed: true });
};
async function connect() {
  const expand = value => value.replaceAll('${PLUGIN_ROOT}', plugin.installedPath);
  const transport = new StdioClientTransport({ command: manifest.command, args: manifest.args.map(expand), cwd: expand(manifest.cwd ?? plugin.installedPath),
    env: { ...getDefaultEnvironment(), AGENTBASE_HOME: state }, stderr: 'pipe' });
  const client = new Client({ name: 'agentbase-data-analysis-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}
async function call(tool, args) {
  const result = await connection.client.callTool({ name: tool, arguments: args });
  if (result.isError) {
    const error = result.structuredContent ?? JSON.parse(result.content[0].text);
    throw Object.assign(new Error(error.message), { code: error.error });
  }
  return result.structuredContent;
}
try {
  await mkdir(root);
  const headers = Object.keys(orders[0]);
  await writeFile(join(root, 'orders.csv'), headers.join(',') + '\n' + rawOrders.map(o => headers.map(key => o[key] ?? '').join(',')).join('\n') + '\n');
  await writeFile(join(root, 'customers.json'), JSON.stringify(customers));
  connection = await connect();
  const project = await call('project_open', { root, name: 'Synthetic sales analysis', goal: 'Validate analysis against independent integer calculations.' });
  const base = { project_id: project.id, actor: 'analysis-validation' };
  const importedOrders = await call('dataset_import', { ...base, request_id: randomUUID(), path: 'orders.csv', name: 'Orders' });
  const importedCustomers = await call('dataset_import', { ...base, request_id: randomUUID(), path: 'customers.json', name: 'Customers' });
  checked('CSV and JSON imports', [[importedOrders.body.row_count, importedCustomers.body.row_count]], [[10005, 120]]);
  const dataset_ids = [importedOrders.id, importedCustomers.id];
  const analyse = (title, sql, max_rows = 100) => call('analysis_run', { ...base, request_id: randomUUID(), title, sql, dataset_ids, max_rows });
  const quality = await analyse('Data quality', `SELECT count(*) AS raw_rows, count(DISTINCT o.order_id) AS unique_orders,
    count(*)-count(DISTINCT o.order_id) AS duplicate_rows,
    count(*) FILTER(WHERE o.customer_id IS NULL) AS missing_customer,
    count(*) FILTER(WHERE o.customer_id IS NOT NULL AND c.customer_id IS NULL) AS unknown_customer
    FROM d1 o LEFT JOIN d2 c USING(customer_id)`);
  const expectedQuality = [[rawOrders.length, orders.length, 5, rawOrders.filter(o => o.customer_id === null).length,
    rawOrders.filter(o => o.customer_id !== null && !customers.some(c => c.customer_id === o.customer_id)).length]];
  checked('Duplicates, nulls, and unmatched foreign keys', quality.body.rows, expectedQuality);
  const monthlyAnalysis = await analyse('Monthly completed revenue', monthlySql);
  const expectedMonthly = [...monthly].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => [month, v.orders, v.cents]);
  checked('Deduplicated monthly revenue', monthlyAnalysis.body.rows, expectedMonthly);
  const regionAnalysis = await analyse('Revenue by customer region', regionSql);
  const expectedRegion = [...regional].sort(([a], [b]) => a.localeCompare(b)).map(([region, v]) => [region, v.orders, v.cents]);
  checked('LEFT JOIN regional revenue', regionAnalysis.body.rows, expectedRegion);
  const running = await analyse('Cumulative monthly revenue', `WITH monthly AS (${monthlySql})
    SELECT month, revenue_cents, sum(revenue_cents) OVER (ORDER BY month ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_cents
    FROM monthly ORDER BY month`);
  let cumulative = 0;
  checked('Window function cumulative revenue', running.body.rows, expectedMonthly.map(([month, count, cents]) => [month, cents, cumulative += cents]));
  const ranked = await analyse('Top five known customers', `WITH clean AS (${deduplicated})
    SELECT c.customer_id, sum(o.quantity * o.unit_price_cents - o.discount_cents) AS revenue_cents
    FROM clean o JOIN d2 c USING(customer_id) WHERE o.status='completed'
    GROUP BY c.customer_id ORDER BY revenue_cents DESC,c.customer_id LIMIT 5`);
  const expectedRanking = [...byCustomer].sort(([a, av], [b, bv]) => bv - av || a - b).slice(0, 5);
  checked('Ranked customer aggregates', ranked.body.rows, expectedRanking);
  const preview = await analyse('Bounded preview', 'SELECT * FROM d1 ORDER BY order_id', 2);
  assert.equal(preview.body.rows.length, 2); assert.equal(preview.body.truncated, true);
  checks.push({ name: 'Bounded preview reports truncation', passed: true });
  await assert.rejects(analyse('Invalid column', 'SELECT column_does_not_exist FROM d1'), { code: 'ANALYSIS_FAILED' });
  checked('Server survives invalid query', (await analyse('Still alive', 'SELECT count(*) FROM d1')).body.rows, [[10005]]);
  await writeFile(join(root, 'orders.csv'), 'order_id,customer_id,order_date,quantity,unit_price_cents,discount_cents,status\n1,1,2026-01-01,1,999999,0,completed\n');
  checked('Source edits do not change the imported snapshot', (await analyse('Immutable input', monthlySql)).body.rows, expectedMonthly);
  await mkdir(output, { recursive: true });
  for (const [name, analysis] of [['monthly-sales', monthlyAnalysis], ['regional-sales', regionAnalysis]]) {
    const exported = await call('artifact_export', { project_id: project.id, analysis_id: analysis.id, format: 'csv' });
    const bytes = await readFile(exported.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), exported.sha256);
    await copyFile(exported.path, join(output, name + '.csv'));
  }
  const exportedJson = await call('artifact_export', { project_id: project.id, analysis_id: monthlyAnalysis.id, format: 'json' });
  checked('JSON export preserves saved results', JSON.parse(await readFile(exportedJson.path, 'utf8')).rows, expectedMonthly);
  await connection.client.close(); connection = await connect();
  const saved = await call('record_get', { project_id: project.id, id: monthlyAnalysis.id });
  checked('Saved analysis survives server restart', saved.body.rows, expectedMonthly);
  checked('Saved dataset is queryable after restart', (await analyse('Reproduce after restart', monthlySql)).body.rows, expectedMonthly);
  report = { status: 'passed', plugin_version: plugin.version, synthetic_data: true,
    method: 'Installed stdio MCP server; SQL results compared with independent JavaScript integer-cent calculations.',
    definitions: { revenue: 'Completed orders only, deduplicated by order_id; excludes cancelled/refunded orders. Synthetic amounts in AUD cents.', unmatched: 'Missing or unknown customer ID.' },
    input: { raw_rows: rawOrders.length, unique_orders: orders.length, customers: customers.length },
    quality: { duplicate_rows: 5, missing_customer: expectedQuality[0][3], unknown_customer: expectedQuality[0][4] },
    totals: { completed_orders: completed, completed_revenue_cents: revenue },
    monthly: expectedMonthly.map(([month, orders, cents]) => ({ month, completed_orders: orders, revenue_cents: cents })),
    regions: expectedRegion.map(([region, orders, cents]) => ({ region, completed_orders: orders, revenue_cents: cents })),
    checks, query_count: 10, test_store_removed: true };
} finally {
  try { await connection?.client.close(); } finally { await rm(directory, { recursive: true, force: true }); }
}
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
