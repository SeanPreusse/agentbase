import { spawn } from 'node:child_process';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from './errors.js';

export interface WorkerInput {
  mode: 'inspect' | 'query';
  datasets: { path: string; extension: string; hash: string }[];
  sql?: string;
  max_rows: number;
}
const runtime = fileURLToPath(new URL('.', import.meta.url));
const modules = fileURLToPath(new URL('../node_modules', import.meta.url));
export async function sandboxCommand(node: string, worker: string, dataPaths: string[], scratch: string) {
  const executable = await realpath(node);
  dataPaths = await Promise.all(dataPaths.map(path => realpath(path)));
  scratch = await realpath(scratch);
  if (process.platform === 'darwin') {
    const quoted = (s: string) => JSON.stringify(s);
    const reads = ['/System', '/usr/lib', '/usr/share', '/Library/Apple', '/private/var/db/dyld', runtime, await realpath(modules)];
    const profile = `(version 1)
      (deny default)
      (allow process-fork)
      (allow process-exec (literal ${quoted(executable)}))
      (allow signal (target self))
      (allow sysctl-read)
      (allow mach-lookup)
      (allow file-read-metadata)
      (allow file-read* (literal "/"))
      (allow file-read-data ${reads.map(p => `(subpath ${quoted(p)})`).join(' ')}
        ${[executable, fileURLToPath(new URL('../package.json', import.meta.url)), '/dev/null', '/dev/urandom', '/dev/random', ...dataPaths].map(p => `(literal ${quoted(p)})`).join(' ')})
      (allow file-write* (subpath ${quoted(scratch)}) (literal "/dev/null"))
      (allow file-read-data (subpath ${quoted(scratch)}))`;
    return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, executable, '--max-old-space-size=192', worker] };
  }
  if (process.platform === 'linux') {
    const bwrap = ['/usr/bin/bwrap', '/bin/bwrap'];
    let binary: string | undefined;
    for (const path of bwrap) { try { await access(path); binary = path; break; } catch {} }
    if (!binary) throw new DomainError('SANDBOX_UNAVAILABLE', 'Data analysis requires bubblewrap on Linux. Install bubblewrap; analysis never falls back to unsandboxed execution.');
    const args = ['--unshare-all', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
    for (const path of ['/usr', '/lib', '/lib64', '/etc/ld.so.cache']) {
      try { await access(path); args.push('--ro-bind', path, path); } catch {}
    }
    for (const path of new Set([runtime, await realpath(modules), fileURLToPath(new URL('../package.json', import.meta.url)), executable, ...dataPaths])) args.push('--ro-bind', path, path);
    args.push('--bind', scratch, scratch, '--', executable, '--max-old-space-size=192', worker);
    return { command: binary, args };
  }
  throw new DomainError('SANDBOX_UNAVAILABLE', 'Analysis currently supports macOS sandbox-exec and Linux bubblewrap. Core memory and task tools work without analysis.');
}

export async function runAnalysisWorker(input: WorkerInput, timeoutMs = 15000): Promise<any> {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'agentbase-query-')));
  try {
    input = { ...input, datasets: await Promise.all(input.datasets.map(async d => ({ ...d, path: await realpath(d.path) }))) };
    const worker = fileURLToPath(new URL('./analysis-worker.js', import.meta.url));
    const launch = await sandboxCommand(process.execPath, worker, input.datasets.map(d => d.path), scratch);
    return await new Promise((resolve, reject) => {
      const child = spawn(launch.command, launch.args, {
        cwd: scratch, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch, LANG: 'en_US.UTF-8' },
      });
      let stdout = '', stderr = '', settled = false;
      const fail = (error: Error) => { if (!settled) { settled = true; child.kill('SIGKILL'); reject(error); } };
      const timer = setTimeout(() => fail(new DomainError('ANALYSIS_TIMEOUT', 'Analysis exceeded its runtime limit. Simplify the query or reduce input size.')), timeoutMs);
      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
        if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) fail(new DomainError('RESULT_TOO_LARGE', 'Analysis result exceeded 2 MiB. Select fewer columns or rows.'));
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
      child.on('error', error => { clearTimeout(timer); fail(new DomainError('SANDBOX_UNAVAILABLE', error.message)); });
      child.stdin.on('error', () => {});
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        try {
          if (code !== 0) throw new DomainError('ANALYSIS_FAILED', stderr.trim() || `Analysis worker exited with ${signal ?? code}.`);
          const result = JSON.parse(stdout);
          if (result.error) throw new DomainError(result.code ?? 'ANALYSIS_FAILED', result.error);
          resolve(result);
        } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify({ ...input, scratch }));
    });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
