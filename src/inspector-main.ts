import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { inspectorSnapshot, watchInspector } from './inspector.js';
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const home = resolve(option('--home') ?? process.env.AGENTBASE_HOME ?? resolve(homedir(), '.local/share/agentbase'));
if (args.includes('--watch')) await watchInspector(home, option('--project'), option('--record'), {includeBackground:args.includes('--include-background'),taskLimit:Number(option('--task-limit')),workingRoot:option('--root'),search:option('--search')});
else console.log(JSON.stringify(inspectorSnapshot(home, option('--project'), option('--record'), {includeBackground:args.includes('--include-background'),taskLimit:Number(option('--task-limit')),workingRoot:option('--root'),search:option('--search')})));
