import { CodexConnection } from './connections.js';
const args=process.argv.slice(2);const option=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
try{
  const action=args[0]??'status';if(!['status','install','enable','disable','check'].includes(action))throw new Error('Unknown setup action.');
  const source=option('--source');if(!source)throw new Error('Plugin source was not provided.');
  const state=await new CodexConnection({source,codex:option('--codex'),codexHome:option('--codex-home'),workspace:option('--workspace')}).perform(action as 'status'|'install'|'enable'|'disable'|'check');console.log(JSON.stringify({ok:true,...state}));
}catch(error){console.log(JSON.stringify({ok:false,error:(error as Error).message}));process.exitCode=1;}
