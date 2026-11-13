import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { invariant } from './errors.js';
const exec = promisify(execFile);
async function hasGitMarker(path: string, ancestors = false): Promise<boolean> {
  let current = path;
  for (;;) {
    try { await stat(join(current, '.git')); return true; }
    catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return true; }
    if (!ancestors) return false;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
async function gitOutput(root: string, ...args: string[]) {
  return (await exec('git', ['--no-optional-locks', '-C', root, ...args], {
    timeout: 3000, maxBuffer: 256 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  })).stdout.replace(/\r?\n$/, '');
}
export async function repositoryIdentity(path: string) {
  const requested = await projectRoot(path);
  if (!await hasGitMarker(requested, true)) return { root: requested, repository_key: null };
  try {
    const root = await realpath(await gitOutput(requested, 'rev-parse', '--show-toplevel'));
    const common = await realpath(await gitOutput(requested, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    return { root, repository_key: common };
  } catch { return { root: requested, repository_key: null }; }
}
export async function projectRoot(path: string) {
  invariant(isAbsolute(path), 'INVALID_PATH', 'Use an absolute project root.');
  const root = await realpath(path);
  invariant((await stat(root)).isDirectory(), 'INVALID_PATH', 'Project root must be a directory.');
  return root;
}
export async function withinRoot(root: string, input: string) {
  const path = await realpath(resolve(root, input));
  const rel = relative(root, path);
  invariant(rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'PATH_DENIED', 'File must be inside the registered project root (symlinks are resolved).');
  return path;
}
export async function repositoryState(root: string) {
  if (!await hasGitMarker(root, true)) return { available: false, reason: 'Git state unavailable; verify working files before resuming.', captured_at: new Date().toISOString() };
  const git = (...args: string[]) => gitOutput(root, ...args);
  try {
    const [head, branch, status, dirtyPaths] = await Promise.all([
      git('rev-parse', '--verify', 'HEAD').catch(() => 'unborn'),
      git('symbolic-ref', '--short', '-q', 'HEAD').catch(() => 'detached'),
      git('status', '--porcelain=v1', '--untracked-files=normal'),
      git('ls-files', '--modified', '--others', '--exclude-standard', '-z'),
    ]);
    // Include dirty/untracked file contents: status codes alone miss successive edits.
    const { hash } = await import('./store.js');
    const paths = dirtyPaths.split('\0').filter(Boolean);
    let totalBytes = 0, complete = paths.length <= 100;
    const fingerprints = await Promise.all(paths.slice(0, 100).map(async path => {
      try {
        const safePath = await withinRoot(root, path);
        const info = await stat(safePath);
        totalBytes += info.size;
        if (!info.isFile() || info.size > 2 * 1024 * 1024 || totalBytes > 8 * 1024 * 1024) { complete = false; return [path, 'not_fingerprinted']; }
        return [path, hash(await readFile(safePath))];
      } catch {
        // A deletion is stable, but an unreadable existing file cannot be compared reliably.
        try { await stat(resolve(root, path)); complete = false; } catch (error: any) { if (error.code !== 'ENOENT') complete = false; }
        return [path, 'missing_or_unreadable'];
      }
    }));
    const index = await git('ls-files', '--stage', '-z');
    return { available: true, head, branch, status, diff_hash: hash(JSON.stringify(fingerprints) + index), fingerprint_complete: complete, captured_at: new Date().toISOString() };
  } catch {
    return { available: false, reason: 'Git state unavailable; verify working files before resuming.', captured_at: new Date().toISOString() };
  }
}
