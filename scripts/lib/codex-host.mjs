import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

// Codex's local app-server protocol, not a model session or API request.
export async function startHost({ cwd, env = process.env, args = [] }) {
  const child = spawn('codex', [...args, 'app-server', '--stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 1, stderr = '';
  const pending = new Map();
  const notifications = [];
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method) {
      if (message.id !== undefined) {
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'No interactive actions are allowed in this test client.' } }) + '\n');
      } else notifications.push(message);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(Object.assign(new Error(message.error.message), { data: message.error.data, rpcCode: message.error.code }));
    else request.resolve(message.result);
  });
  const rejectAll = error => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  };
  child.on('error', rejectAll);
  child.on('exit', (code, signal) => rejectAll(new Error(`Codex host exited (${signal ?? code}). ${stderr}`)));
  const request = (method, params = {}, timeout = 45000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out. ${stderr}`)); }, timeout);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const stop = async (signal = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill(signal);
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(timer); lines.close(); }
  };
  try {
    await request('initialize', { clientInfo: { name: 'agentbase-development', version: '0.2.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    return { request, stop, child, notifications, diagnostics: () => stderr };
  } catch (error) { await stop(); throw error; }
}

export async function waitForMcp(host, threadId, name = 'agentbase') {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const inventory = await host.request('mcpServerStatus/list', { threadId }, 15000);
    const server = inventory.data.find(s => s.name === name);
    if (server && Object.keys(server.tools).length) return server;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${name} did not finish MCP startup within 15 seconds. ${host.diagnostics()}`);
}
