import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {CodexConnection} from '../dist/connections.js';
const source=resolve('.');let codex;try{codex=execFileSync('which',['codex'],{encoding:'utf8'}).trim();}catch{}

test('connection status explains missing Codex without making an installation',async t=>{
 const scratch=await mkdtemp(join(tmpdir(),'agentbase-no-codex-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
 const result=await new CodexConnection({source,codex:join(scratch,'missing'),codexHome:join(scratch,'profile')}).perform('status');
 assert.equal(result.codex_available,false);assert.equal(result.installed,false);assert.equal(result.install_available,true);
 await assert.rejects(stat(join(scratch,'profile')),{code:'ENOENT'});
});

test('native setup installs, verifies MCP, disables and re-enables an isolated Codex profile without altering other settings or project state',{skip:!codex,timeout:90000},async t=>{
 const scratch=await mkdtemp(join(tmpdir(),'agentbase-connection-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
 const home=join(scratch,'codex');await mkdir(home);
 const config='approval_policy = "on-request"\n\n[agentbase_test]\nmarker = "preserve-me"\n';await writeFile(join(home,'config.toml'),config);
 const connection=new CodexConnection({source,codex,codexHome:home});
 const initial=await connection.status();assert.equal(initial.installed,false);
 const installed=await connection.perform('install');assert.equal(installed.installed,true);assert.equal(installed.enabled,true);assert.equal(installed.reconnect_required,true);
 assert.equal(await readFile(join(installed.backup,'config.toml'),'utf8'),config);assert.equal((await stat(join(installed.backup,'config.toml'))).mode & 0o777,0o600);
 let contents=await readFile(join(home,'config.toml'),'utf8');assert.ok(contents.includes('approval_policy = "on-request"'));assert.ok(contents.includes('marker = "preserve-me"'));
 const disabled=await connection.perform('disable');assert.equal(disabled.enabled,false);assert.match(disabled.message,/new sessions/);assert.match(disabled.message,/memory is retained/);
 const beforeCheck=await readFile(join(home,'config.toml'),'utf8');
 const check=await connection.perform('check');assert.equal(check.enabled,false);assert.ok(check.tool_count>=28);assert.ok(check.checked_at);assert.match(check.message,/not an existing Codex session/);
 assert.equal(await readFile(join(home,'config.toml'),'utf8'),beforeCheck);
 const enabled=await connection.perform('enable');assert.equal(enabled.enabled,true);
 contents=await readFile(join(home,'config.toml'),'utf8');assert.ok(contents.includes('approval_policy = "on-request"'));assert.ok(contents.includes('marker = "preserve-me"'));
 const lock=new DatabaseSync(join(home,'agentbase-setup.sqlite'));lock.exec('BEGIN IMMEDIATE');
 try{await assert.rejects(connection.perform('disable'),/Another setup action/);}finally{lock.exec('ROLLBACK');lock.close();}
 assert.equal((await connection.status()).enabled,true);
 const otherSource=join(scratch,'other-source');await mkdir(join(otherSource,'dist'),{recursive:true});await writeFile(join(otherSource,'plugin.json'),JSON.stringify({name:'agentbase'}));await writeFile(join(otherSource,'dist/cli.js'),'');
 await assert.rejects(new CodexConnection({source:otherSource,codex,codexHome:home}).perform('install'),/another installation/);
 assert.equal(await readFile(join(home,'config.toml'),'utf8'),contents);
 await assert.rejects(new CodexConnection({source,codex,codexHome:home,node:join(scratch,'missing-node')}).perform('check'),/ENOENT/);
});
