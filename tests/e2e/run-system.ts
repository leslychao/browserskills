/** Owned local fixture integration. Uses real PostgreSQL, Spring and Chromium; the model is a stub. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, access, writeFile,copyFile,unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { BrowserOwner } from '../../apps/browser/src/owner.js';
import { createWorkerServer } from '../../apps/browser/src/server.js';
import { startYangFixture } from '../../apps/browser/test/yang-fixture.js';

const root=resolve('.');
const rfbMode=process.argv.includes('--rfb');
const fixtureModes=['normal','lost','voices','aspects','conditional'] as const;
const requestedMode=process.argv.find(arg=>arg.startsWith('--fixture='))?.slice('--fixture='.length);
if(requestedMode&&!fixtureModes.includes(requestedMode as typeof fixtureModes[number]))throw new Error('Unknown owned fixture mode');
if(!rfbMode&&!requestedMode){
  // Each shared workspace gets its own isolated database/profile and one fixture type.
  for(const mode of fixtureModes){
    const run=spawn(process.execPath,[fileURLToPath(import.meta.url),`--fixture=${mode}`],{cwd:root,env:process.env,windowsHide:true,stdio:'inherit'});
    const code=await new Promise<number>((done,reject)=>{run.once('error',reject);run.once('exit',code=>done(code??1));});
    if(code!==0)process.exit(code);
  }
  process.exit(0);
}
const fixtureMode=(requestedMode??'normal') as typeof fixtureModes[number];
const directory=join(root,'.cache','system',randomUUID());
await mkdir(directory,{recursive:true});
const children:ChildProcess[]=[];
const cleanup:Array<()=>Promise<unknown>>=[];
const password=randomBytes(24).toString('hex');
const workerToken=randomBytes(32).toString('hex');
const diagnosticToken=randomBytes(32).toString('hex');
const container=`browserskills-system-${randomUUID()}`;
const java=process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java';
const sourceJar=resolve(process.env.API_TEST_JAR??'apps/api/target/browserskills-api-0.1.0.jar');
await access(sourceJar);
const jar=join(directory,'api.jar');await copyFile(sourceJar,jar);

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

  const sites:Array<Awaited<ReturnType<typeof startYangFixture>>>=[];
  const workerPorts=[];
  for(const index of [0,1,2,3,4]){
    const mode=index===0?fixtureMode:'normal';
    const fixture=await startYangFixture(mode);sites.push(fixture);cleanup.push(fixture.close);
    const owner=new BrowserOwner({workerId:`browser-${index+1}`,profileDir:join(directory,`profile-${index}`),mediaDir:join(directory,`media-${index}`),headless:true,startUrl:fixture.url,adapterOptions:{origin:fixture.url,frameOrigin:fixture.url,mediaOrigins:[fixture.url],instructionOrigins:[fixture.url]},verificationTimeoutMs:600});
    const app=createWorkerServer(owner,workerToken);workerPorts.push(await listen(app.server));
    cleanup.push(()=>owner.close());
  }
  let analyses=0;let instructionAnalyses=0;let audioAnalyses=0;
  const model=createServer(async(request,response)=>{
    if(request.method==='GET'&&request.url==='/health'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({status:'ok'}));return;}
    if(request.method!=='POST'||!['/v1/chat/completions','/tokenize'].includes(request.url??'')){response.writeHead(404);response.end();return;}
    let source='';for await(const chunk of request){source+=chunk;if(source.length>8*1024*1024){response.writeHead(413);response.end();return;}}
    const payload=JSON.parse(source);
    if(request.url==='/tokenize'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({tokens:Array.from({length:Math.ceil(String(payload.content??'').length/3)},(_,i)=>i)}));return;}
    analyses++;
    const material=JSON.stringify(payload.messages);
    if(material.includes('"type":"input_audio"'))audioAnalyses++;
    const schema=payload.response_format.json_schema.schema;
    const properties=schema.properties??{};
    let answer:unknown;
    if(properties.sourceId){instructionAnalyses++;answer={sourceId:properties.sourceId.const,rules:'Complete every required field. Preserve original sides. Overall preference precedes aspect ratings.',complete:true,contentOnlySpeech:false};}
    else if(properties.sourceIds){answer={sourceIds:properties.sourceIds.items.enum};}
    else if(schema.anyOf?.some((branch:{properties?:{decision?:{const?:string}}})=>branch.properties?.decision?.const==='ANSWER')){
      const fieldBlock=payload.messages[1].content.find((part:{text?:string})=>part.text?.startsWith('ANSWER EXACTLY THESE FIELDS: '));
      const fields=JSON.parse(fieldBlock.text.slice('ANSWER EXACTLY THESE FIELDS: '.length));
      const partBlock=payload.messages[1].content.find((part:{text?:string})=>part.text?.startsWith('CURRENT PART '));
      const partId=partBlock.text.slice('CURRENT PART '.length).split('\n')[0];
      answer={decision:'ANSWER',reason:null,answers:fields.map((field:{id:string;kind:string;options:Array<{id:string}>;min:number|null})=>({partId,fieldId:field.id,value:field.kind==='NUMBER'?field.min??1:field.kind==='TEXT'?'Fixture explanation':field.kind==='MULTI_CHOICE'?field.options.map(o=>o.id):field.options[0].id}))};
    }else{response.writeHead(422);response.end();return;}
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]}));
  });
  const modelPort=await listen(model);
  const diagnostics=createServer((request,response)=>{
    if(request.headers.authorization!==`Bearer ${diagnosticToken}`){response.writeHead(401);response.end();return;}
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify({fixture:true,analyses,audioAnalyses,instructionAnalyses,sites:sites.map(site=>({current:site.state.suite,reservations:site.state.reservations,submissions:site.state.submissions}))}));
  });
  const diagnosticsPort=await listen(diagnostics);
  const apiPort=await freePort();const webPort=await freePort();
  // A non-localhost origin exercises ordinary LAN HTTP; only Chromium resolves this fixture name.
  const publicOrigin=`http://${rfbMode?'rfb-http.test':'127.0.0.1'}:${webPort}`;
  const fixtureModelHash='a'.repeat(64);const fixtureEvidence=join(directory,'quality-evidence.fixture.json');
  await writeFile(fixtureEvidence,JSON.stringify({modelSha256:fixtureModelHash,categories:['TEXT','IMAGE','SPEECH','SOUND_PROSODY'].map(category=>({category,total:25,correct:25,wholeSets:true,corpusSha256:'b'.repeat(64),evaluatedAt:new Date().toISOString()}))}));
  const environment:NodeJS.ProcessEnv={SPRING_DATASOURCE_URL:`jdbc:postgresql://127.0.0.1:${port}/browserskills`,SPRING_DATASOURCE_USERNAME:'postgres',SPRING_DATASOURCE_PASSWORD:password,API_INFERENCE_URL:`http://127.0.0.1:${modelPort}`,API_DEV_URL:`http://127.0.0.1:${apiPort}`,API_MODEL_SHA256:fixtureModelHash,API_MATERIALS_DIR:join(directory,'materials'),API_QUALITY_EVIDENCE_PATH:fixtureEvidence,BROWSERSKILLS_DAILY_QUOTA:'1000',...(rfbMode?{__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS:'rfb-http.test'}:{})};
  workerPorts.forEach((workerPort,index)=>{environment[`API_WORKER_${index+1}_URL`]=`http://127.0.0.1:${workerPort}`;environment[`worker_${index+1}_token`]=workerToken;});
  if(rfbMode){
    const entry=join(directory,'headed-worker.mjs');
    await build({entryPoints:['tests/test-site/worker.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:entry});
    const name=`browserskills-rfb-system-${randomUUID()}`;
    await command('docker',['run','--detach','--rm','--init','--name',name,'--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--security-opt',`seccomp=${resolve('ops/seccomp-profile.json')}`,'--shm-size=1g','--tmpfs','/tmp:size=268435456,mode=1777','--tmpfs','/run/browser:size=268435456,uid=1001,gid=1001,mode=0700','--publish','127.0.0.1::3000','--publish','127.0.0.1::3001','--mount',`type=bind,source=${entry},target=/app/apps/browser/dist/main.js,readonly`,'--mount',`type=bind,source=${resolve('tests/test-site')},target=/app/tests/test-site,readonly`,'--env','FIXTURE_WORKER_TOKEN','--env','FIXTURE_WORKER_PORT=3000','--env','FIXTURE_SITE_PORT=3001','--env','FIXTURE_WORKER_ID=browser-1','--entrypoint','/bin/bash',process.env.SYSTEM_RFB_IMAGE??'browserskills-browser:local','/app/tests/test-site/start-worker.sh'],{FIXTURE_WORKER_TOKEN:workerToken});
    cleanup.push(()=>command('docker',['rm','--force',name]));
    const headedPort=(await command('docker',['port',name,'3000/tcp'])).split(':').at(-1)!;
    environment.API_WORKER_1_URL=`http://127.0.0.1:${headedPort}`;
    const fixturePort=(await command('docker',['port',name,'3001/tcp'])).split(':').at(-1)!;
    environment.SYSTEM_RFB_FIXTURE_URL=`http://127.0.0.1:${fixturePort}`;
    environment.SYSTEM_RFB_REMOTE_FIXTURE_URL='http://127.0.0.1:3001';
    const deadline=Date.now()+30_000;let ready=false;
    while(Date.now()<deadline){try{if((await fetch(`${environment.API_WORKER_1_URL}/health/live`,{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}await new Promise(done=>setTimeout(done,200));}
    if(!ready)throw new Error('Headed Docker worker did not become ready');
  }
  const api=child(java,['-jar',jar,'--spring.profiles.active=dev',`--server.port=${apiPort}`,`--api.public-origin=${publicOrigin}`],environment);
  await waitHttp(`http://127.0.0.1:${apiPort}/health/live`,api);
  await command(process.execPath,['node_modules/vite/bin/vite.js','build','apps/web'],environment);
  const vite=child(process.execPath,['node_modules/vite/bin/vite.js','preview','apps/web','--host','127.0.0.1','--port',String(webPort),'--strictPort'],environment);
  await waitHttp(`http://127.0.0.1:${webPort}`,vite);
  process.stdout.write('Fixture system ready: real PostgreSQL + Spring + Chromium; stub model.\n');
  const test=child(process.execPath,['node_modules/@playwright/test/cli.js','test','-c','tests/e2e/system.config.ts'],{...environment,SYSTEM_RFB_MODE:rfbMode?'1':'0',SYSTEM_FIXTURE_MODE:fixtureMode,SYSTEM_URL:publicOrigin,SYSTEM_DIAGNOSTICS_URL:`http://127.0.0.1:${diagnosticsPort}`,SYSTEM_DIAGNOSTICS_TOKEN:diagnosticToken});
  test.processHandle.stdout!.on('data',chunk=>process.stdout.write(chunk));test.processHandle.stderr!.on('data',chunk=>process.stderr.write(chunk));
  const deadline=setTimeout(()=>test.processHandle.kill(),480_000);
  process.exitCode=await test.done.finally(()=>clearTimeout(deadline));
  await writeFile(join(directory,'api.log'),api.output(),'utf8');
}finally{
  for(const running of children.toReversed())if(running.exitCode===null)running.kill();
  for(const close of cleanup.toReversed())try{await close();}catch(error){process.stderr.write(`Fixture cleanup: ${error instanceof Error?error.message:'failed'}\n`);}
  await unlink(jar).catch(()=>undefined);
}
