import { ClaudeCodeConnection, CodexConnection } from './connections.js';
const args=process.argv.slice(2);const option=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
try{
  const action=args[0]??'status',host=option('--host')??'codex';
  const source=option('--source');if(!source)throw new Error('Plugin source was not provided.');
  const options={source,codex:option('--codex'),claude:option('--claude'),node:option('--node'),codexHome:option('--codex-home'),workspace:option('--workspace'),home:option('--home')};
  const state=host==='claude'
    ? await new ClaudeCodeConnection(options).perform(action as 'status'|'install'|'remove'|'check')
    : host==='codex'
      ? await new CodexConnection(options).perform(action as 'status'|'install'|'enable'|'disable'|'check')
      : (()=>{throw new Error('Unknown setup host.');})();
  console.log(JSON.stringify({ok:true,...state}));
}catch(error){console.log(JSON.stringify({ok:false,error:(error as Error).message}));process.exitCode=1;}
