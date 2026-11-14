import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { writeMemoryFixture, originalImplementation } from './lib/memory-fixture.mjs';

const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'agentbase-claude-memory-eval-'));
const root = join(directory, 'project'), state = join(directory, 'state');
const outputFlag = process.argv.find(arg => arg.startsWith('--output='));
const output = outputFlag ? resolve(outputFlag.slice('--output='.length)) : resolve('test-results/model-memory-claude');
const timeoutFlag = process.argv.find(arg => arg.startsWith('--timeout-seconds='));
const timeoutSeconds = timeoutFlag ? Number(timeoutFlag.split('=')[1]) : 300;
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 900) throw new Error('Phase timeout must be 30–900 seconds.');
const report = { status: 'running', host: 'claude', phases: [], checks: [], model_calls: true,
  limits: ['One synthetic scenario; not a reliability benchmark.', 'Uses the installed Claude Code login and a disposable AgentBase store.'] };
const check = (name, passed, detail) => report.checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
const snapshot = () => {
  if (!existsSync(join(state, 'agentbase.sqlite'))) return [];
  const db = new DatabaseSync(join(state, 'agentbase.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT * FROM records ORDER BY rowid').all().map(row => ({ ...row, body: JSON.parse(row.body) })); }
  finally { db.close(); }
};

async function runPhase(name, prompt, config) {
  const events = [], tools = [];
  let stderr = '', timedOut = false;
  const started = Date.now();
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', config,
    '--no-session-persistence', '--permission-mode', 'acceptEdits', '--max-budget-usd', '2',
    '--allowedTools', 'mcp__agentbase__*', 'Read', 'Edit', 'Bash(node --test *)'];
  const child = spawn('claude', args, { cwd: root, env: { ...process.env, AGENTBASE_HOME: state }, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutSeconds * 1000);
  const forced = setTimeout(() => child.kill('SIGKILL'), timeoutSeconds * 1000 + 5000);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const event = JSON.parse(line);
      events.push(event);
      for (const block of event.message?.content ?? []) if (block.type === 'tool_use') tools.push({ name: block.name, id: block.id });
    } catch {}
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
  const result = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer); clearTimeout(forced); lines.close();
  await writeFile(join(output, `${name}.jsonl`), events.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
  const apiRetries = events.filter(event => event.type === 'system' && event.subtype === 'api_retry');
  const phase = { name, ...result, elapsed_seconds: Math.round((Date.now() - started) / 1000), timeout: timedOut,
    tools: tools.map(tool => tool.name), usage: events.filter(event => event.type === 'result').map(event => event.usage),
    model: events.find(event => event.type === 'system' && event.subtype === 'init')?.model ?? null,
    api_retry_count: apiRetries.length, assistant_messages: events.filter(event => event.type === 'assistant').length,
    errors: events.filter(event => event.type === 'result' && event.is_error).map(event => event.result) };
  report.phases.push(phase);
  if (timedOut) throw new Error(phase.assistant_messages === 0 && phase.api_retry_count > 0
    ? `${name} could not reach the Claude model API after ${phase.api_retry_count} retries; the ${timeoutSeconds}-second phase limit expired.`
    : `${name} exceeded its ${timeoutSeconds}-second limit.`);
  if (result.code !== 0) throw new Error(`${name} failed: ${stderr || JSON.stringify(phase.errors)}`);
  return phase;
}

try {
  await mkdir(root);
  await mkdir(output, { recursive: true });
  const config = join(directory, 'mcp.json');
  await writeFile(config, JSON.stringify({ mcpServers: { agentbase: {
    command: process.execPath, args: [resolve('bin/agentbase.mjs'), 'serve', '--home', state],
  } } }), { mode: 0o600 });
  const fixture = await writeMemoryFixture(root, directory);
  const capture = await runPhase('capture',
    'This project uses AgentBase. Investigate the invoice importer and plan the fix. Our partner reuses invoice numbers across customers, so identity must include customer_id and invoice_number. Amounts must remain integer cents and reimporting the same invoice must be idempotent. Investigate and plan only; do not edit the implementation or tests yet. We will implement in the next session. Work only in this fixture. Do not spawn other agents.', config);
  const captured = snapshot();
  await writeFile(join(output, 'capture-records.json'), JSON.stringify(captured, null, 2), { mode: 0o600 });
  check('Planning phase leaves implementation unchanged', await readFile(join(root, 'importer.mjs'), 'utf8') === originalImplementation);
  check('AgentBase context retrieved', capture.tools.some(tool => /context_get$|project_resume$/.test(tool)));
  const knowledge = captured.filter(record => ['memory', 'decision'].includes(record.kind));
  check('Composite invoice identity recorded', knowledge.some(record => /customer/i.test(JSON.stringify(record.body)) && /invoice/i.test(JSON.stringify(record.body))));
  check('Integer-cents constraint recorded', knowledge.some(record => /integer/i.test(JSON.stringify(record.body)) && /cent/i.test(JSON.stringify(record.body))));
  check('Session-only instruction excluded from durable memory', !knowledge.some(record => /investigate and plan only|this session is investigation/i.test(JSON.stringify(record.body))));
  check('Plan and unfinished task recorded', captured.some(record => record.kind === 'plan') && captured.some(record => record.kind === 'task' && !['done', 'cancelled'].includes(record.body.status)));
  check('Handoff contains next action', captured.some(record => record.kind === 'checkpoint' && record.body.next_action));

  const resume = await runPhase('resume',
    'Continue this project’s unfinished invoice importer work in a fresh session. Use its existing AgentBase context and verify the result. Work only in this fixture. Do not spawn other agents.', config);
  const after = snapshot();
  check('Fresh session retrieves durable context', resume.tools.some(tool => /context_get$|project_resume$/.test(tool)));
  try { await exec(process.execPath, ['--test', fixture.acceptancePath], { cwd: root }); check('Implementation passes independent tests', true); }
  catch (error) { check('Implementation passes independent tests', false, error.stdout); }
  check('Completion includes evidence', after.some(record => record.kind === 'task' && record.body.status === 'done' && record.body.completion?.evidence?.length));
  report.record_counts = Object.fromEntries([...new Set(after.map(record => record.kind))].map(kind => [kind, after.filter(record => record.kind === kind).length]));
  report.status = report.checks.every(item => item.passed) ? 'passed' : 'failed';
  await writeFile(join(output, 'records.json'), JSON.stringify(after, null, 2), { mode: 0o600 });
} catch (error) {
  report.status = 'blocked';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (existsSync(join(state, 'agentbase.sqlite'))) await writeFile(join(output, 'exit-records.json'), JSON.stringify(snapshot(), null, 2), { mode: 0o600 });
  for (const file of ['importer.mjs', 'importer.test.mjs']) if (existsSync(join(root, file))) await cp(join(root, file), join(output, file));
  await rm(directory, { recursive: true, force: true });
  report.temporary_profile_removed = true;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
