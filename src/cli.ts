import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store } from './store.js';
import { Agentbase } from './service.js';
import { descriptions, outputSchemas, serve, toolTitle } from './server.js';
import { schemas, type ToolName } from './schemas.js';
import { doctor } from './doctor.js';
import { VERSION } from './version.js';

const help = `Agentbase ${VERSION} — local project storage and memory for agents

Usage:
  agentbase serve                         Start the stdio MCP server
  agentbase init [project-directory]      Register a local project
  agentbase call <tool> [json | @file | -] Call a tool (use - for stdin)
  agentbase tools [tool]                  List tools or show input and output schemas
  agentbase config                       Print local Codex MCP configuration
  agentbase status [project-directory]    Show project tasks and recent activity
  agentbase inspect [--watch] [--project <id>]  Read-only JSON for the native inspector
  agentbase projects [query]              Find registered projects
  agentbase doctor                        Test MCP, storage, and sandboxed analysis in a temporary store
  agentbase backup <project-id> <dir>      Back up project state and dataset bytes to a new directory
  agentbase verify <backup-dir>           Validate backup structure and checksums
  agentbase restore <backup-dir> <root>    Restore into an unregistered project directory

Options:
  --home <directory>   Data directory (default: AGENTBASE_HOME or ~/.local/share/agentbase)

No account, web server, or model API key required. All state stays on this machine.
`;

export async function main(args = process.argv.slice(2)) {
  const homeIndex = args.indexOf('--home');
  let home = process.env.AGENTBASE_HOME ?? resolve(homedir(), '.local/share/agentbase');
  if (homeIndex >= 0) {
    if (!args[homeIndex + 1]) throw new Error('--home requires a directory.');
    home = resolve(args[homeIndex + 1]!); args.splice(homeIndex, 2);
  }
  const [command, ...rest] = args;
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  if (command === 'doctor') {
    const result = await doctor();
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'failed') process.exitCode = 1;
    return;
  }
  if (command === 'config') {
    const executable = fileURLToPath(new URL('../bin/agentbase.mjs', import.meta.url));
    console.log(`# Add to your Codex config.toml; absolute paths also work from another checkout.\n[mcp_servers.agentbase]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(executable)}, "serve", "--home", ${JSON.stringify(home)}]`);
    return;
  }
  if (command === 'tools') {
    if (rest[0]) {
      if (!(rest[0] in schemas)) throw new Error('Unknown tool.');
      const name = rest[0] as ToolName;
      console.log(JSON.stringify({ name, title: toolTitle(name), description: descriptions[name],
        inputSchema: z.toJSONSchema(schemas[name], { io: 'input' }),
        ...(outputSchemas[name] ? { outputSchema: z.toJSONSchema(outputSchemas[name]!, { io: 'output' }) } : {}) }, null, 2));
    } else console.log(Object.entries(descriptions).map(([name, description]) => `${toolTitle(name as ToolName)} (${name})\n  ${description}`).join('\n\n'));
    return;
  }
  if (command === 'inspect') {
    const { inspectorSnapshot, watchInspector } = await import('./inspector.js');
    const index = rest.indexOf('--project');
    if (index >= 0 && !rest[index + 1]) throw new Error('--project requires an ID.');
    const projectId = index >= 0 ? rest[index + 1] : undefined;
    const recordIndex = rest.indexOf('--record');
    if (recordIndex >= 0 && !rest[recordIndex + 1]) throw new Error('--record requires an ID.');
    const recordId = recordIndex >= 0 ? rest[recordIndex + 1] : undefined;
    if (rest.includes('--watch')) await watchInspector(resolve(home), projectId, recordId, {includeBackground:rest.includes('--include-background'),search:rest.includes('--search') ? rest[rest.indexOf('--search')+1] : undefined,workingRoot:rest.includes('--root') ? rest[rest.indexOf('--root')+1] : undefined,taskLimit:rest.includes('--task-limit') ? Number(rest[rest.indexOf('--task-limit')+1]) : undefined});
    else console.log(JSON.stringify(inspectorSnapshot(resolve(home), projectId, recordId, {includeBackground:rest.includes('--include-background'),search:rest.includes('--search') ? rest[rest.indexOf('--search')+1] : undefined,workingRoot:rest.includes('--root') ? rest[rest.indexOf('--root')+1] : undefined,taskLimit:rest.includes('--task-limit') ? Number(rest[rest.indexOf('--task-limit')+1]) : undefined})));
    return;
  }
  const store = new Store(resolve(home));
  const service = new Agentbase(store);
  if (command === 'serve') { await serve(service); return; }
  try {
    let result: unknown;
    if (command === 'init') result = await service.call('project_open', { root: resolve(rest[0] ?? '.') });
    else if (command === 'projects') result = await service.call('project_list', { query: rest[0] });
    else if (command === 'backup') {
      if (!rest[0] || !rest[1]) throw new Error('Usage: agentbase backup <project-id> <new-directory>');
      const { randomUUID } = await import('node:crypto');
      result = await service.call('project_backup', { project_id: rest[0], destination: resolve(rest[1]), actor: 'cli', request_id: randomUUID() });
    } else if (command === 'verify') {
      if (!rest[0]) throw new Error('Usage: agentbase verify <backup-directory>');
      result = await service.call('backup_verify', { backup_path: resolve(rest[0]) });
    } else if (command === 'restore') {
      if (!rest[0] || !rest[1]) throw new Error('Usage: agentbase restore <backup-directory> <existing-project-directory>');
      const { randomUUID } = await import('node:crypto');
      result = await service.call('project_restore', { backup_path: resolve(rest[0]), root: resolve(rest[1]), actor: 'cli', request_id: randomUUID() });
    }
    else if (command === 'call') {
      if (!rest[0] || !(rest[0] in schemas)) throw new Error('Choose a tool from agentbase tools.');
      let payload = rest[1] ?? '{}';
      if (payload === '-') {
        payload = '';
        for await (const chunk of process.stdin) { payload += chunk; if (payload.length > 2 * 1024 * 1024) throw new Error('Input exceeds 2 MiB.'); }
      } else if (payload.startsWith('@')) payload = await readFile(payload.slice(1), 'utf8');
      result = await service.call(rest[0] as ToolName, JSON.parse(payload));
    } else if (command === 'status') {
      const project = await service.call('project_open', { root: resolve(rest[0] ?? '.') });
      const tasks = await service.call('task_list', { project_id: project.id, limit: 100 });
      const counts: Record<string, number> = {};
      for (const record of store.all(project.id, 'task')) counts[record.body.status] = (counts[record.body.status] ?? 0) + 1;
      const handoff = await service.call('handoff_get', { project_id: project.id, root: project.working_root });
      result = { project, counts, tasks, handoff, latest_checkpoint: handoff.checkpoint };
    } else throw new Error(`Unknown command ${command}. Use --help.`);
    console.log(JSON.stringify(result, null, 2));
  } finally { store.close(); }
}
