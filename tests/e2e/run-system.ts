/** Owned local fixture integration. Uses real PostgreSQL, Spring and Chromium; the model is a stub. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { build } from 'esbuild';
import { BrowserOwner } from '../../apps/browser/src/owner.js';
import { createWorkerServer } from '../../apps/browser/src/server.js';
import { fixtureProfile } from '../../apps/browser/test/fixture-profile.js';
import { startTestSite } from '../test-site/server.js';

const root=resolve('.');
const rfbMode=process.argv.includes('--rfb');
const directory=join(root,'.cache','system',randomUUID());
await mkdir(directory,{recursive:true});
const children:ChildProcess[]=[];
const cleanup:Array<()=>Promise<unknown>>=[];
const password=randomBytes(24).toString('hex');
const workerToken=randomBytes(32).toString('hex');
const diagnosticToken=randomBytes(32).toString('hex');
const container=`browserskills-system-${randomUUID()}`;
const java=process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java';
const jar=resolve(process.env.API_TEST_JAR??'apps/api/target/browserskills-api-0.1.0.jar');
await access(jar);

function child(command:string,args:string[],env:NodeJS.ProcessEnv={},input?:string){
  const processHandle=spawn(command,args,{cwd:root,env:{...process.env,...env},windowsHide:true,stdio:['pipe','pipe','pipe']});
  children.push(processHandle);
  let output='';
  processHandle.stdout!.on('data',chunk=>{output=(output+chunk).slice(-100_000);});
  processHandle.stderr!.on('data',chunk=>{output=(output+chunk).slice(-100_000);});
  processHandle.stdin!.end(input);
  const done=new Promise<number>((done,reject)=>{processHandle.once('error',reject);processHandle.once('exit',code=>done(code??1));});
  return {processHandle,done,output:()=>output};
}
async function command(commandName:string,args:string[],env:NodeJS.ProcessEnv={},input?:string){
  const running=child(commandName,args,env,input);
  const timer=setTimeout(()=>running.processHandle.kill(),120_000);
  const code=await running.done.finally(()=>clearTimeout(timer));
  if(code!==0)throw new Error(`${commandName} failed (${code}): ${running.output().replaceAll(password,'[redacted]').replaceAll(workerToken,'[redacted]')}`);
  return running.output().trim();
}
async function listen(server:Server){server.listen(0,'127.0.0.1');await once(server,'listening');cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});return(server.address() as {port:number}).port;}
async function freePort(){const server=createTcpServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));return port;}
async function waitHttp(url:string,running:ReturnType<typeof child>){
  const deadline=Date.now()+90_000;
  while(Date.now()<deadline){
    if(running.processHandle.exitCode!==null)throw new Error(`Service exited before readiness: ${running.output()}`);
    try{if((await fetch(url,{signal:AbortSignal.timeout(1000)})).ok)return;}catch{}
    await new Promise(done=>setTimeout(done,200));
  }
  throw new Error(`Readiness timed out: ${url}`);
}

try{
  await command('ffmpeg',['-version']);await command('ffprobe',['-version']);
  await command('docker',['run','--detach','--rm','--name',container,'--env','POSTGRES_PASSWORD','--env','POSTGRES_DB=browserskills','--publish','127.0.0.1::5432','postgres:17.9-bookworm@sha256:47f917f7409eacd22fc5dfb1dee634e1b55cf0c01d1a7eb701be2227a03e0641'],{POSTGRES_PASSWORD:password});
  cleanup.push(()=>command('docker',['rm','--force',container]));
  const port=(await command('docker',['port',container,'5432/tcp'])).split(':').at(-1)!;
  let dbReady=false;
  for(let i=0;i<50;i++){
    const probe=child('docker',['exec',container,'pg_isready','-U','postgres','-d','browserskills']);
    if(await probe.done===0){dbReady=true;break;}
    await new Promise(done=>setTimeout(done,200));
  }
  if(!dbReady)throw new Error('PostgreSQL readiness timed out');

  const sites=[];
  const workerPorts=[];
  for(const [index,mode] of (['normal','lost','image','audio','instruction-audio'] as const).entries()){
    const fixture=await startTestSite(mode);sites.push(fixture);cleanup.push(fixture.close);
    const owner=new BrowserOwner({workerId:`browser-${index+1}`,profileDir:join(directory,`profile-${index}`),mediaDir:join(directory,`media-${index}`),headless:true,startUrl:fixture.url,profiles:[fixtureProfile(fixture.url)],verificationTimeoutMs:600});
    const app=createWorkerServer(owner,workerToken);workerPorts.push(await listen(app.server));
    cleanup.push(()=>owner.close());
  }
  let analyses=0;let incompleteInstructions=0;let audioAnalyses=0;
  const model=createServer(async(request,response)=>{
    let source='';for await(const chunk of request){source+=chunk;if(source.length>8*1024*1024){response.writeHead(413);response.end();return;}}
    const payload=JSON.parse(source);analyses++;
    const material=JSON.stringify(payload.messages);
    if(material.includes('"type":"input_audio"'))audioAnalyses++;
    if(!material.includes('Read the whole question.')||!material.includes('Example: sky'))incompleteInstructions++;
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({decision:'ANSWER',optionId:'blue'})}}]}));
  });
  const modelPort=await listen(model);
  const diagnostics=createServer((request,response)=>{
    if(request.headers.authorization!==`Bearer ${diagnosticToken}`){response.writeHead(401);response.end();return;}
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify({fixture:true,analyses,audioAnalyses,incompleteInstructions,sites:sites.map(site=>({current:site.state.current,submissions:site.state.submissions}))}));
  });
  const diagnosticsPort=await listen(diagnostics);
  const apiPort=await freePort();const webPort=await freePort();
  const environment:NodeJS.ProcessEnv={SPRING_DATASOURCE_URL:`jdbc:postgresql://127.0.0.1:${port}/browserskills`,SPRING_DATASOURCE_USERNAME:'postgres',SPRING_DATASOURCE_PASSWORD:password,API_INFERENCE_URL:`http://127.0.0.1:${modelPort}`,API_DEV_URL:`http://127.0.0.1:${apiPort}`};
  workerPorts.forEach((workerPort,index)=>{environment[`API_WORKER_${index+1}_URL`]=`http://127.0.0.1:${workerPort}`;environment[`worker_${index+1}_token`]=workerToken;});
  if(rfbMode){
    const entry=join(directory,'headed-worker.mjs');
    await build({entryPoints:['tests/test-site/worker.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:entry});
    const name=`browserskills-rfb-system-${randomUUID()}`;
    await command('docker',['run','--detach','--rm','--init','--name',name,'--cap-drop=ALL','--security-opt','no-new-privileges','--security-opt',`seccomp=${resolve('ops/seccomp-profile.json')}`,'--shm-size=1g','--publish','127.0.0.1::3000','--mount',`type=bind,source=${entry},target=/app/tests/fixture-worker.mjs,readonly`,'--mount',`type=bind,source=${resolve('tests/test-site')},target=/app/tests/test-site,readonly`,'--env','FIXTURE_WORKER_TOKEN','--env','FIXTURE_WORKER_PORT=3000','--env','FIXTURE_WORKER_ID=browser-1','--entrypoint','/bin/bash',process.env.SYSTEM_RFB_IMAGE??'browserskills-browser:local','/app/tests/test-site/start-worker.sh'],{FIXTURE_WORKER_TOKEN:workerToken});
    cleanup.push(()=>command('docker',['rm','--force',name]));
    const headedPort=(await command('docker',['port',name,'3000/tcp'])).split(':').at(-1)!;
    environment.API_WORKER_1_URL=`http://127.0.0.1:${headedPort}`;
    const deadline=Date.now()+30_000;let ready=false;
    while(Date.now()<deadline){try{if((await fetch(`${environment.API_WORKER_1_URL}/health/live`,{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}await new Promise(done=>setTimeout(done,200));}
    if(!ready)throw new Error('Headed Docker worker did not become ready');
  }
  for(const login of ['alice','bob','carol','david','eve'])await command(java,['-jar',jar,'--spring.main.web-application-type=none','--spring.profiles.active=admin',`--create-user=${login}`],environment,password+'\n');
  const api=child(java,['-jar',jar,'--spring.profiles.active=dev',`--server.port=${apiPort}`,`--api.public-origin=http://127.0.0.1:${webPort}`],environment);
  await waitHttp(`http://127.0.0.1:${apiPort}/health/live`,api);
  const vite=child(process.execPath,['node_modules/vite/bin/vite.js','apps/web','--host','127.0.0.1','--port',String(webPort),'--strictPort'],environment);
  await waitHttp(`http://127.0.0.1:${webPort}`,vite);
  process.stdout.write('Fixture system ready: real PostgreSQL + Spring + Chromium; stub model.\n');
  const test=child(process.execPath,['node_modules/@playwright/test/cli.js','test','-c','tests/e2e/system.config.ts'],{...environment,SYSTEM_RFB_MODE:rfbMode?'1':'0',SYSTEM_URL:`http://127.0.0.1:${webPort}`,SYSTEM_PASSWORD:password,SYSTEM_DIAGNOSTICS_URL:`http://127.0.0.1:${diagnosticsPort}`,SYSTEM_DIAGNOSTICS_TOKEN:diagnosticToken});
  test.processHandle.stdout!.on('data',chunk=>process.stdout.write(chunk));test.processHandle.stderr!.on('data',chunk=>process.stderr.write(chunk));
  const deadline=setTimeout(()=>test.processHandle.kill(),240_000);
  process.exitCode=await test.done.finally(()=>clearTimeout(deadline));
  await writeFile(join(directory,'api.log'),api.output(),'utf8');
}finally{
  for(const running of children.toReversed())if(running.exitCode===null)running.kill();
  for(const close of cleanup.toReversed())try{await close();}catch(error){process.stderr.write(`Fixture cleanup: ${error instanceof Error?error.message:'failed'}\n`);}
}
