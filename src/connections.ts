import { DatabaseSync } from 'node:sqlite';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { readFile, mkdir, copyFile, chmod, mkdtemp, rm, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

const exec = promisify(execFile);
const PLUGIN = 'agentbase@agentbase-local';
export interface ConnectionOptions { source: string; codex?: string; claude?: string; codexHome?: string; node?: string; workspace?: string; home?: string; }
export interface ConnectionState { codex_available?: boolean; claude_available?: boolean; installed: boolean; enabled: boolean; version?: string; install_available: boolean; message: string; reconnect_required: boolean; tool_count?: number; codex_tool_count?: number; codex_skill_count?: number; checked_workspace?: string; checked_at?: string; backup?: string; store_path?: string; store_path_source?: 'argument'|'environment'|'default_assumed'|'unknown'; }

const defaultStore = () => join(homedir(), '.local/share/agentbase');
function storeFromCommand(args: string[], env: Record<string,string> = {}, inheritsHome = false): Pick<ConnectionState,'store_path'|'store_path_source'> {
  const flag = args.lastIndexOf('--home');
  if (flag >= 0) return isAbsolute(args[flag + 1] ?? '')
    ? {store_path:resolve(args[flag + 1]!),store_path_source:'argument'} : {store_path_source:'unknown'};
  if (env.AGENTBASE_HOME) return isAbsolute(env.AGENTBASE_HOME)
    ? {store_path:resolve(env.AGENTBASE_HOME),store_path_source:'environment'} : {store_path_source:'unknown'};
  return inheritsHome ? {store_path_source:'unknown'} : {store_path:defaultStore(),store_path_source:'default_assumed'};
}

// Bounded local protocol client. No turns, prompts, credentials, or approval changes.
async function rpc(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const child=spawn(command,args,{env,cwd,stdio:['pipe','pipe','pipe']});
  const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();let id=0;
  const lines=createInterface({input:child.stdout});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
  const fail=(error:Error)=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
  child.on('error',fail);child.on('exit',()=>fail(new Error('Local setup process stopped before replying.')));
  lines.on('line',line=>{if(line.length>16*1024*1024){child.kill();fail(new Error('Setup response exceeded its limit.'));return;}let m:any;try{m=JSON.parse(line);}catch{return;}
    if(m.method){if(m.id!==undefined)child.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'Setup does not allow interactive requests.'}})+'\n');return;}
    const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(String(m.error.message))):p.resolve(m.result);
  });
  const request=(method:string,params:unknown={})=>new Promise<any>((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(new Error('Local setup timed out.'));child.kill();},12000);pending.set(key,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');});
  const notify=(method:string)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',method})+'\n');
  const stop=async()=>{lines.close();if(!child.pid||child.exitCode!==null||child.signalCode!==null)return;await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill();const timer=setTimeout(()=>child.kill('SIGKILL'),1000);timer.unref();child.once('exit',()=>clearTimeout(timer));});};
  try {await new Promise<void>((resolve,reject)=>{child.once('spawn',()=>resolve());child.once('error',reject);});}
  catch(error){lines.close();throw error;}
  return {request,notify,stop};
}

export class CodexConnection {
  readonly home:string; readonly env:NodeJS.ProcessEnv; readonly codex:string;
  constructor(readonly options:ConnectionOptions){this.home=resolve(options.codexHome??process.env.CODEX_HOME??join(homedir(),'.codex'));this.codex=options.codex??'codex';this.env={...process.env,CODEX_HOME:this.home};}
  private async command(args:string[]){const {stdout}=await exec(this.codex,[...args,'--json'],{env:this.env,cwd:homedir(),timeout:25000,maxBuffer:2*1024*1024});return JSON.parse(stdout);}
  private async sourceAvailable(){try{const manifest=JSON.parse(await readFile(join(this.options.source,'plugin.json'),'utf8'));await readFile(join(this.options.source,'dist/cli.js'));return manifest.name==='agentbase';}catch{return false;}}
  private async configuredStore():Promise<Pick<ConnectionState,'store_path'|'store_path_source'>> {
    try {
      const config=await this.command(['mcp','get','agentbase']);
      if(config.transport?.type!=='stdio')return {store_path_source:'unknown'};
      const args=Array.isArray(config.transport.args)?config.transport.args.filter((v:unknown):v is string=>typeof v==='string'):[];
      if(![config.transport.command,...args].some(value=>typeof value==='string' && /agentbase(?:-launch\.sh|\.mjs)/iu.test(value)))return {store_path_source:'unknown'};
      const env=config.transport.env && typeof config.transport.env==='object'?config.transport.env:{};
      return storeFromCommand(args,env,config.transport.env_vars?.includes('AGENTBASE_HOME') || !!this.env.AGENTBASE_HOME);
    } catch {return {store_path_source:'unknown'};}
  }
  async status():Promise<ConnectionState>{
    const install_available=await this.sourceAvailable();
    try {const listing=await this.command(['plugin','list']);const plugin=listing.installed?.find((p:any)=>p.pluginId===PLUGIN);
      const store=plugin?await this.configuredStore():{};
      return {codex_available:true,installed:!!plugin,enabled:plugin?.enabled===true,version:plugin?.version,install_available,message:plugin?(plugin.enabled?'Enabled for new Codex sessions.':'Disabled for new Codex sessions.'):'Install AgentBase with its memory, planning and analysis skills.',reconnect_required:false,...store};
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {codex_available:false,installed:false,enabled:false,install_available,message:'Codex was not found. Install Codex, then reopen AgentBase.',reconnect_required:false};throw new Error('Could not read Codex plugin settings. Check your Codex installation.');}
  }
  private async backup(){const directory=await mkdtemp(join(this.home,'agentbase-setup-backup-'));await chmod(directory,0o700);try{await copyFile(join(this.home,'config.toml'),join(directory,'config.toml'));await chmod(join(directory,'config.toml'),0o600);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}return directory;}
  private async setEnabled(enabled:boolean){const host=await rpc(this.codex,['app-server','--stdio'],this.env,homedir());try{
    await host.request('initialize',{clientInfo:{name:'agentbase-setup',version:'1.0.0'},capabilities:{experimentalApi:true}});host.notify('initialized');
    await host.request('config/value/write',{keyPath:`plugins."${PLUGIN}".enabled`,value:enabled,mergeStrategy:'replace'});
  }finally{await host.stop();}}
  private async installedRoot(version:string|undefined){if(!version || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(version))throw new Error('Installed plugin version is invalid.');const root=join(this.home,'plugins/cache/agentbase-local/agentbase',version);const manifest=JSON.parse(await readFile(join(root,'plugin.json'),'utf8'));if(manifest.name!=='agentbase'||manifest.version!==version)throw new Error('Installed plugin files do not match Codex settings. Reinstall Agentbase.');return root;}
  private async codexCapabilities(){
    const workspace=this.options.workspace?await realpath(this.options.workspace):homedir();
    const host=await rpc(this.codex,['app-server','--stdio'],this.env,workspace);
    try{
      await host.request('initialize',{clientInfo:{name:'agentbase-setup-check',version:'1.0.0'},capabilities:{experimentalApi:true}});
      host.notify('initialized');
      const skills=await host.request('skills/list',{cwds:[workspace],forceReload:true});
      const enabledSkills=skills.data?.flatMap((entry:any)=>entry.skills??[]).filter((skill:any)=>skill.name.startsWith('agentbase:')&&skill.enabled)??[];
      if(!enabledSkills.some((skill:any)=>skill.name==='agentbase:agentbase-resume'))
        throw new Error(`Codex did not load the AgentBase task workflow skill in ${workspace}. Check this project's .codex/config.toml or managed policy.`);
      const started=await host.request('thread/start',{cwd:workspace,ephemeral:true,approvalPolicy:'never'});
      const deadline=Date.now()+15000;
      do{
        const inventory=await host.request('mcpServerStatus/list',{threadId:started.thread.id});
        const server=inventory.data?.find((item:any)=>item.name==='agentbase');
        const count=Object.keys(server?.tools??{}).length;
        if(count)return {tools:count,skills:enabledSkills.length,workspace};
        await new Promise(resolve=>setTimeout(resolve,200));
      }while(Date.now()<deadline);
      throw new Error(`Codex did not register AgentBase tools in ${workspace}. Check the MCP server command and project policy.`);
    }finally{await host.stop();}
  }
  async perform(action:'status'|'install'|'enable'|'disable'|'check'):Promise<ConnectionState>{
    const before=await this.status();if(action==='status'||!before.codex_available)return before;
    if(action==='check'){
      if(!before.installed)throw new Error('Install Agentbase before checking setup.');
      const root=await this.installedRoot(before.version);const scratch=await mkdtemp(join(tmpdir(),'agentbase-connection-check-'));let server:Awaited<ReturnType<typeof rpc>>|undefined;
      try{server=await rpc(this.options.node??process.execPath,[join(root,'bin/agentbase.mjs'),'serve'],{...this.env,AGENTBASE_HOME:join(scratch,'state')},root);
        const hello=await server.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'agentbase-setup-check',version:'1.0.0'}});server.notify('notifications/initialized');const tools=await server.request('tools/list');
        if(hello.serverInfo?.version!==before.version || !['project_open','context_get','task_claim','analysis_run'].every(name=>tools.tools?.some((t:any)=>t.name===name)))throw new Error('Installed server did not expose the expected Agentbase tools.');
        const capabilities=before.enabled?await this.codexCapabilities():{tools:0,skills:0,workspace:undefined};
        return {...before,tool_count:tools.tools.length,codex_tool_count:capabilities.tools,codex_skill_count:capabilities.skills,
          checked_workspace:capabilities.workspace,checked_at:new Date().toISOString(),
          message:before.enabled?`Codex loaded ${capabilities.tools} AgentBase tools and ${capabilities.skills} skills for ${basename(capabilities.workspace!)}. Existing chats may need reconnecting.`:`Installed server passed with ${tools.tools.length} tools, but AgentBase is disabled in Codex.`};
      }finally{await server?.stop();await rm(scratch,{recursive:true,force:true});}
    }
    if(action!=='install'&&!before.installed)throw new Error('Install Agentbase first.');
    await mkdir(this.home,{recursive:true});
    const lock=new DatabaseSync(join(this.home,'agentbase-setup.sqlite'),{timeout:1000});
    try{await chmod(join(this.home,'agentbase-setup.sqlite'),0o600);lock.exec('CREATE TABLE IF NOT EXISTS setup_lock (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;');}
    catch{lock.close();throw new Error('Another setup action is running. Wait for it to finish, then retry.');}
    let backup:string|undefined;
    try{
      backup=await this.backup();
      if(action==='install'){
        if(!before.install_available)throw new Error('Plugin source is unavailable. Rebuild the inspector from the Agentbase package.');
        const markets=await this.command(['plugin','marketplace','list']);const existing=markets.marketplaces?.find((m:any)=>m.name==='agentbase-local');
        if(existing && (await realpath(existing.root))!==(await realpath(this.options.source)))throw new Error('agentbase-local belongs to another installation. It was left unchanged.');
        if(!existing)await this.command(['plugin','marketplace','add',resolve(this.options.source)]);
        await this.command(['plugin','add',PLUGIN]);
      }else await this.setEnabled(action==='enable');
      const after=await this.status();const wanted=action!=='disable';
      if(action==='install'){const sourceManifest=JSON.parse(await readFile(join(this.options.source,'plugin.json'),'utf8'));if(after.version!==sourceManifest.version)throw new Error('Codex did not install the expected Agentbase version. Refresh the marketplace and retry.');await this.installedRoot(after.version);}
      if(!after.installed||after.enabled!==wanted)throw new Error('Codex did not confirm the requested setting. A project or managed policy may override it.');
      return {...after,backup,reconnect_required:true,message:wanted?'Enabled. Reconnect Codex or start a new session to load Agentbase.':'Disabled for new sessions. Reconnect existing sessions to unload Agentbase. Your project memory is retained.'};
    }catch(error){throw new Error(`${(error as Error).message}${backup?` Settings backup: ${backup}`:''}`);}
    finally{lock.exec('ROLLBACK;');lock.close();}
  }
}

export class ClaudeCodeConnection {
  readonly claude: string;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  constructor(readonly options: ConnectionOptions) {
    this.claude = options.claude ?? 'claude';
    this.env = { ...process.env };
    this.home = resolve(options.home ?? process.env.AGENTBASE_HOME ?? join(homedir(), '.local/share/agentbase'));
  }
  private async sourceAvailable() {
    try { await readFile(join(this.options.source, 'bin/agentbase.mjs')); return true; }
    catch { return false; }
  }
  private async listing() {
    const { stdout } = await exec(this.claude, ['mcp', 'list'], { env: this.env, cwd: homedir(), timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
    const line = stdout.split(/\r?\n/u).find(value => /^\s*agentbase\s*:/iu.test(value));
    return line?.trim();
  }
  private health(line?: string) {
    return line?.match(/\b(?:failed|error|pending approval|needs authentication|disabled|not connected|connected)\b/iu)?.[0];
  }
  private async configuredStore():Promise<Pick<ConnectionState,'store_path'|'store_path_source'>> {
    try {
      const {stdout}=await exec(this.claude,['mcp','get','agentbase'],{env:this.env,cwd:homedir(),timeout:25000,maxBuffer:2*1024*1024});
      if(!/^\s*Type:\s*stdio\s*$/miu.test(stdout))return {store_path_source:'unknown'};
      const args=stdout.match(/^\s*Args:\s*(.*)$/miu)?.[1]??'';
      const command=stdout.match(/^\s*Command:\s*(.*)$/miu)?.[1]??'';
      if(!/agentbase(?:-launch\.sh|\.mjs)/iu.test(command+' '+args))return {store_path_source:'unknown'};
      const marker=' --home ';
      const index=(' '+args).lastIndexOf(marker);
      if(index>=0){const path=(' '+args).slice(index+marker.length).trim();return isAbsolute(path) && !/\s--[a-z]/iu.test(path)?{store_path:resolve(path),store_path_source:'argument'}:{store_path_source:'unknown'};}
      if(/AGENTBASE_HOME/iu.test(stdout) || this.env.AGENTBASE_HOME)return {store_path_source:'unknown'};
      return {store_path:defaultStore(),store_path_source:'default_assumed'};
    } catch {return {store_path_source:'unknown'};}
  }
  async status(): Promise<ConnectionState> {
    const install_available = await this.sourceAvailable();
    try {
      const line = await this.listing();
      const health = this.health(line);
      const store=line?await this.configuredStore():{};
      return { claude_available: true, installed: !!line, enabled: !!line, install_available, message: !line ? 'Not installed' : health ? health.replace(/\b\w/gu, char => char.toUpperCase()) : 'Installed', reconnect_required: false, ...store };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { claude_available: false, installed: false, enabled: false, install_available, message: 'Claude Code not found', reconnect_required: false };
      throw new Error('Could not read Claude Code MCP settings. Check your Claude Code installation.');
    }
  }
  async perform(action: 'status' | 'install' | 'remove' | 'check'): Promise<ConnectionState> {
    const before = await this.status();
    if (action === 'status' || before.claude_available !== true) return before;
    if (action === 'install') {
      if (!before.install_available) throw new Error('AgentBase server files are unavailable. Rebuild the inspector package.');
      if (before.installed) throw new Error('AgentBase is already configured in Claude Code. Refresh to check its status.');
      const node = this.options.node ?? process.execPath;
      const command = join(this.options.source, 'bin/agentbase.mjs');
      await exec(this.claude, ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'agentbase', '--', node, command, 'serve', '--home', this.home], { env: this.env, cwd: homedir(), timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
      const after = await this.status();
      if (!after.installed) throw new Error('Claude Code did not confirm the AgentBase MCP server.');
      return { ...after, reconnect_required: true, message: 'Installed · reconnect Claude Code' };
    }
    if (!before.installed) throw new Error('Install AgentBase in Claude Code first.');
    if (action === 'remove') {
      await exec(this.claude, ['mcp', 'remove', 'agentbase', '--scope', 'user'], { env: this.env, cwd: homedir(), timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
      const after = await this.status();
      return { ...after, reconnect_required: true, message: after.installed ? 'Removed user install · another scope still defines AgentBase' : 'Removed · AgentBase data is kept' };
    }
    const line = await this.listing();
    if (!line) throw new Error('Claude Code could not find the AgentBase MCP server.');
    const health = this.health(line);
    if (health && /^(?:failed|error|pending approval|needs authentication|disabled|not connected)$/iu.test(health)) throw new Error(`Claude Code reports AgentBase is ${health.toLowerCase()}.`);
    return { ...before, checked_at: new Date().toISOString() };
  }
}
