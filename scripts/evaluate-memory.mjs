import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, writeFile, cp, symlink, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { installedPlugin, codexJson, PLUGIN_ID } from './lib/plugin-installation.mjs';
import { startHost } from './lib/codex-host.mjs';
const exec = promisify(execFile);
const plugin = await installedPlugin();
const directory = await mkdtemp(join(tmpdir(), 'agentbase-model-eval-'));
const root = join(directory, 'project'), state = join(directory, 'state'), home = join(directory, 'home'), codexHome = join(directory, 'codex');
const output = resolve('test-results/model-memory');
const useAccountDefault = process.argv.includes('--account-default');
const outputFlag = process.argv.find(arg => arg.startsWith('--output='));
const reportOutput = outputFlag ? resolve(outputFlag.slice('--output='.length)) : output;
const timeoutFlag = process.argv.find(arg => arg.startsWith('--timeout-seconds='));
const phaseTimeout = timeoutFlag ? Number(timeoutFlag.split('=')[1]) : 300;
assert.ok(Number.isInteger(phaseTimeout) && phaseTimeout >= 30 && phaseTimeout <= 900, 'Phase timeout must be 30–900 seconds.');
const report = { status: 'running', plugin_version: plugin.version, phases: [], checks: [], limits: ['One synthetic scenario; not a reliability benchmark.'], model_calls: true };
const env = { ...process.env, HOME: home, CODEX_HOME: codexHome };

async function runModel(name, prompt, stopAtCheckpoint = false) {
  const events = [], tools = [];
  let stderr = '', interrupted = false, timeout = false;
  const startedAt = Date.now();
  const child = spawn('codex', ['exec', '--ephemeral', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', root, '-'], {
    cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  const kill = signal => {
    try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch {}
  };
  const timer = setTimeout(() => { timeout = true; kill('SIGTERM'); }, phaseTimeout * 1000);
  const forced = setTimeout(() => kill('SIGKILL'), phaseTimeout * 1000 + 5000);
  const progress = setInterval(() => console.log(JSON.stringify({ phase: name, running_seconds: Math.round((Date.now() - startedAt)/1000), completed_tools: tools.length, last_event: events.at(-1)?.type })), 30000);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const event = JSON.parse(line); event.observed_at = new Date().toISOString(); events.push(event);
      const item = event.item;
      if (item?.type === 'mcp_tool_call' && event.type === 'item.completed') {
        const isError = item.result?.isError ?? item.result?.is_error ?? Boolean(item.error);
        tools.push({ server: item.server, tool: item.tool, status: item.status, isError });
        if (stopAtCheckpoint && /checkpoint_save$/.test(item.tool) && item.status === 'completed' && !isError) {
          interrupted = true; kill('SIGTERM');
        }
      }
    } catch {}
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  const result = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer); clearTimeout(forced); clearInterval(progress); lines.close();
  await writeFile(join(reportOutput, `${name}.jsonl`), events.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
  const phase = { name, ...result, elapsed_seconds: Math.round((Date.now() - startedAt)/1000), interrupted_after_checkpoint: interrupted, timeout, tools,
    usage: events.filter(e => e.type === 'turn.completed').map(e => e.usage),
    errors: events.filter(e => e.type === 'error' || e.type === 'turn.failed') };
  report.phases.push(phase);
  console.log(JSON.stringify({ phase: name, ...result, interrupted, timeout, tool_calls: tools.map(t => t.tool) }));
  if (timeout) throw new Error(`${name} exceeded its ${phaseTimeout}-second limit.`);
  if (result.code !== 0 && !interrupted) throw new Error(`${name} failed: ${JSON.stringify(phase.errors)} ${stderr}`);
  return { events, phase };
}
function snapshot() {
  if (!existsSync(join(state, 'agentbase.sqlite'))) return [];
  const db = new DatabaseSync(join(state, 'agentbase.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT * FROM records ORDER BY rowid').all().map(r => ({ ...r, body: JSON.parse(r.body) })); }
  finally { db.close(); }
}
function check(name, passed, detail) {
  report.checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
}
try {
  await Promise.all([mkdir(root), mkdir(home), mkdir(codexHome), mkdir(reportOutput, { recursive: true })]);
  // Reuse the existing login without copying credentials into fixture artifacts.
  await symlink(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'), join(codexHome, 'auth.json'));
  const userConfig = await readFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'), 'utf8');
  const defaults = userConfig.split('\n').filter(line => /^(model|model_provider|model_reasoning_effort)\s*=/.test(line))
    .filter(line => !useAccountDefault || !/^(model|model_provider)\s*=/.test(line));
  report.model_configuration = defaults;
  report.uses_account_default = useAccountDefault;
  await writeFile(join(codexHome, 'config.toml'), defaults.join('\n') + '\napproval_policy = "never"\n[analytics]\nenabled=false\n' +
    `[plugins."${PLUGIN_ID}".mcp_servers.agentbase]\ndefault_tools_approval_mode="approve"\n`, { mode: 0o600 });
  const replica = join(directory, 'plugin');
  await cp(plugin.installedPath, replica, { recursive: true });
  const mcp = JSON.parse(await readFile(join(replica, 'mcp.json'), 'utf8'));
  mcp.mcpServers.agentbase.args.push('--home', state);
  await writeFile(join(replica, 'mcp.json'), JSON.stringify(mcp, null, 2));
  await codexJson(['plugin', 'marketplace', 'add', replica], { cwd: root, env });
  await codexJson(['plugin', 'add', PLUGIN_ID], { cwd: root, env });
  const probe = await startHost({ cwd: root, env });
  try {
    const models = await probe.request('model/list', {});
    report.account_default_model = models.data.find(m => m.isDefault)?.model ?? null;
  } finally { await probe.stop(); }
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
  const originalImplementation = `export function importInvoices(existing, incoming) {
  const seen = new Set(existing.map(row => row.invoice_number));
  const result = [...existing];
  for (const row of incoming) {
    if (!seen.has(row.invoice_number)) { result.push({...row}); seen.add(row.invoice_number); }
  }
  return result;
}\n`;
  await writeFile(join(root, 'importer.mjs'), originalImplementation);
  const originalTests = `import test from 'node:test';
import assert from 'node:assert/strict';
import {importInvoices} from './importer.mjs';
test('retains invoices belonging to different customers',()=>{
  const rows=[{customer_id:'a',invoice_number:'7',amount_cents:1234},{customer_id:'b',invoice_number:'7',amount_cents:5678}];
  assert.deepEqual(importInvoices([],rows),rows);
});
test('repeat imports remain idempotent and preserve integer cents',()=>{
  const rows=[{customer_id:'a',invoice_number:'7',amount_cents:1234}];
  assert.deepEqual(importInvoices(rows,rows),rows);
  assert.equal(Number.isInteger(importInvoices([],rows)[0].amount_cents),true);
});
test('composite identities do not collide when identifiers contain separators',()=>{
  const rows=[{customer_id:'a:b',invoice_number:'c',amount_cents:1},{customer_id:'a',invoice_number:'b:c',amount_cents:2}];
  assert.deepEqual(importInvoices([],rows),rows);
});\n`;
  await writeFile(join(root, 'importer.test.mjs'), originalTests);
  const acceptancePath = join(directory, 'original-acceptance.test.mjs');
  await writeFile(acceptancePath, originalTests.replace("'./importer.mjs'", JSON.stringify(pathToFileURL(join(root, 'importer.mjs')).href)));
  await writeFile(join(root, 'README.md'), 'Invoice import fixture. Run `npm test` to check behaviour.\n');
  const first = await runModel('capture', `This project uses Agentbase. Investigate the invoice importer and plan the fix. Our partner reuses invoice numbers across customers, so identity must include customer_id and invoice_number. Amounts must remain integer cents and reimporting the same invoice must be idempotent. Investigate and plan only; do not edit the implementation or tests yet. We will implement in the next session. Work only in this fixture, apart from reading installed skill instructions. Do not spawn other agents.`, true);
  const captured = snapshot();
  await writeFile(join(reportOutput, 'capture-records.json'), JSON.stringify(captured, null, 2), { mode: 0o600 });
  check('Planning phase leaves implementation unchanged', await readFile(join(root, 'importer.mjs'), 'utf8') === originalImplementation);
  check('Agentbase context retrieved', first.phase.tools.some(t => /context_get$/.test(t.tool) && t.status === 'completed' && !t.isError));
  const knowledge = captured.filter(r => ['memory', 'decision'].includes(r.kind));
  check('Composite invoice identity recorded', knowledge.some(r => /customer/i.test(JSON.stringify(r.body)) && /invoice/i.test(JSON.stringify(r.body))));
  check('Integer-cents constraint recorded', knowledge.some(r => /integer/i.test(JSON.stringify(r.body)) && /cent/i.test(JSON.stringify(r.body))));
  check('Session-only stop conditions excluded from project memory', !knowledge.some(r => /planning.only|investigat(?:e|ion)[ -](?:only|and planning only)|implementation and tests must remain unchanged|this session is investigation/i.test(JSON.stringify(r.body))));
  check('Plan recorded', captured.some(r => r.kind === 'plan'));
  check('Unfinished task recorded', captured.some(r => r.kind === 'task' && !['done', 'cancelled'].includes(r.body.status)));
  check('Handoff contains next action', captured.some(r => r.kind === 'checkpoint' && r.body.next_action));
  check('No premature implementation completion', !captured.some(r => r.kind === 'task' && r.body.status === 'done' && !/investigat|plan|analys|diagnos/i.test(r.body.title)));
  const second = await runModel('resume', `Continue this project's unfinished work. Use its existing project context and verify the result. Work only in this fixture, apart from reading installed skill instructions. Do not spawn other agents.`);
  const after = snapshot();
  check('Fresh session retrieves durable context', second.phase.tools.some(t => /context_get$/.test(t.tool) && t.status === 'completed' && !t.isError));
  try { await exec(process.execPath, ['--test', acceptancePath], { cwd: root }); check('Implementation passes independent tests', true); }
  catch (error) { check('Implementation passes independent tests', false, error.stdout); }
  check('Completion includes evidence', after.some(r => r.kind === 'task' && r.body.status === 'done' && r.body.completion?.evidence?.length));
  check('A checkpoint was the interruption boundary', first.phase.interrupted_after_checkpoint && first.phase.signal === 'SIGTERM');
  report.status = report.checks.every(c => c.passed) ? 'passed' : 'failed';
  report.record_counts = Object.fromEntries([...new Set(after.map(r => r.kind))].map(kind => [kind, after.filter(r => r.kind === kind).length]));
  await writeFile(join(reportOutput, 'records.json'), JSON.stringify(after, null, 2), { mode: 0o600 });
} catch (error) {
  report.status = 'blocked'; report.error = error.message;
  process.exitCode = 1;
} finally {
  try {
    if (existsSync(join(state, 'agentbase.sqlite'))) await writeFile(join(reportOutput, 'exit-records.json'), JSON.stringify(snapshot(), null, 2), { mode: 0o600 });
    for (const file of ['importer.mjs', 'importer.test.mjs']) {
      if (existsSync(join(root, file))) await cp(join(root, file), join(reportOutput, file));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    report.temporary_profile_removed = true;
  }
  await writeFile(join(reportOutput, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
