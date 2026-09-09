/** Real production entrypoint: stop a headed Chromium and reopen its persistent profile. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root=resolve('.');
const id=`browserskills-profile-${randomUUID()}`;
const directory=join(root,'.cache','profile-lifecycle',id);
const volume=`${id}-data`;
const marker=`fixture-${randomUUID()}`;
const containers:string[]=[];
let volumeCreated=false;
const evidence:{mode:string;profile:unknown;exitCode:number;locks:Record<string,string|null>;logs:string}[]=[];
const image=process.env.BROWSER_DOCKER_IMAGE??'browserskills-browser:local';

async function docker(args:string[],timeout=90_000){
  const child=spawn('docker',args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk).slice(-30_000);});
  const timer=setTimeout(()=>child.kill(),timeout);
  try{
    const code=await new Promise<number>((done,reject)=>{child.once('error',reject);child.once('exit',code=>done(code??1));});
    if(code!==0)throw new Error(`Docker command failed (${code}): ${output}`);
    return output.trim();
  }finally{clearTimeout(timer);}
}

try{
  await mkdir(directory,{recursive:true});
  const bundle=join(directory,'profile-lifecycle.mjs');
  await build({entryPoints:[join(root,'apps/browser/test/profile-lifecycle.ts')],bundle:true,platform:'node',format:'esm',packages:'external',outfile:bundle});
  const startScript=(await readFile(join(root,'apps/browser/start.sh'),'utf8')).replaceAll('\r\n','\n');
  const startPath=join(directory,'browser-start');await writeFile(startPath,startScript);
  const imageId=await docker(['image','inspect',image,'--format','{{.Id}}']);
  await docker(['volume','create','--label','browserskills.test=profile-lifecycle',volume]);volumeCreated=true;
  for(const mode of ['seed','read']){
    const container=`${id}-${mode}`;containers.push(container);
    await docker(['run','--detach','--name',container,'--init','--network','none','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--security-opt',`seccomp=${join(root,'ops/seccomp-profile.json')}`,'--memory','1536m','--cpus','1.5','--pids-limit','256','--shm-size','1g','--tmpfs','/tmp:size=268435456,mode=1777','--tmpfs','/run/browser:size=268435456,uid=1001,gid=1001,mode=0700','--mount',`type=volume,source=${volume},target=/data/profile`,'--mount',`type=bind,source=${bundle},target=/app/apps/browser/dist/main.js,readonly`,'--mount',`type=bind,source=${startPath},target=/usr/local/bin/browser-start,readonly`,'--env','WORKER_ID=browser-1','--env',`PROFILE_TEST_MODE=${mode}`,'--env',`PROFILE_TEST_MARKER=${marker}`,image]);
    let profile:{match?:boolean}|undefined;
    for(let attempt=0;attempt<100;attempt++){
      try{profile=JSON.parse(await docker(['exec',container,'node','-e',"process.stdout.write(require('fs').readFileSync('/tmp/profile-evidence.json','utf8'))"]));break;}catch{
        if(await docker(['inspect',container,'--format','{{.State.Running}}'])!=='true')throw new Error(`Worker exited before ${mode} evidence: ${await docker(['logs',container])}`);
        await new Promise(done=>setTimeout(done,100));
      }
    }
    assert(profile,`${mode} evidence timed out`);
    // Stop immediately after the page reports the write, without waiting for Chrome's periodic flush.
    await docker(['stop','--time','45',container],60_000);
    const exitCode=Number(await docker(['inspect',container,'--format','{{.State.ExitCode}}']));
    const locks:Record<string,string|null>=JSON.parse(await docker(['run','--rm','--network','none','--read-only','--mount',`type=volume,source=${volume},target=/data/profile,readonly`,'--entrypoint','node',image,'-e',"const fs=require('fs');const locks={};for(const name of ['SingletonLock','SingletonCookie','SingletonSocket']){try{locks[name]=fs.readlinkSync('/data/profile/'+name)}catch(error){if(error.code!=='ENOENT')throw error;locks[name]=null}}process.stdout.write(JSON.stringify(locks))"]));
    evidence.push({mode,profile,exitCode,locks,logs:await docker(['logs',container])});
    assert.equal(profile.match,true,`${mode}: cookie/localStorage did not persist across container/hostname replacement`);
    assert.notEqual(exitCode,137,`${mode}: Docker killed the worker after its graceful-stop deadline`);
    assert(Object.values(locks).every(value=>value===null),`${mode}: Chromium left stale process locks after stop: ${JSON.stringify(locks)}`);
  }
  const report={passed:true,imageId,startScriptSha256:createHash('sha256').update(startScript).digest('hex'),fixtureSha256:createHash('sha256').update(await readFile(bundle)).digest('hex'),evidence};
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));
  process.stdout.write(`Persistent cookie and localStorage survived production Docker stop and container replacement. Report: ${join(directory,'report.json')}\n`);
}catch(error){
  await writeFile(join(directory,'failure.json'),JSON.stringify({passed:false,evidence,error:String(error)},null,2));
  throw error;
}finally{
  for(const container of containers.reverse())await docker(['rm','--force',container]).catch(()=>undefined);
  if(volumeCreated)await docker(['volume','rm',volume]).catch(()=>undefined);
}
