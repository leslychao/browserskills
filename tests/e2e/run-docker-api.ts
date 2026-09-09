/** Production image smoke: real PostgreSQL, verified TLS, static bundle and session lifecycle. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { resolve, join, sep } from 'node:path';

const root=resolve('.');
const base=join(root,'.cache','docker-api');
const directory=join(base,randomUUID());
const network=`browserskills-api-smoke-${randomUUID()}`;
const postgres=`${network}-pg`;
const api=`${network}-app`;
const password=randomBytes(24).toString('hex');
const containers:string[]=[];
let networkCreated=false;

async function command(executable:string,args:string[],input?:string,env:NodeJS.ProcessEnv={}){
  const child=spawn(executable,args,{cwd:root,env:{...process.env,...env},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='';
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk).slice(-100_000);});
  const timer=setTimeout(()=>child.kill(),180_000);
  try{
    const finished=new Promise<number>((done,reject)=>{child.once('error',reject);child.stdin.once('error',reject);child.once('exit',code=>done(code??1));});
    child.stdin.end(input);
    const code=await finished;
    if(code!==0)throw new Error(`${executable} failed (${code}): ${output.replaceAll(password,'[redacted]')}`);
    return output.trim();
  }finally{clearTimeout(timer);}
}
const mount=(name:string,target=name)=>['--mount',`type=bind,source=${join(directory,name)},target=/run/secrets/${target},readonly`];

try{
  await mkdir(directory,{recursive:true});
  await command('pwsh',['-NoProfile','-Command',`
    . './ops/windows/Common.ps1'
    Set-ProtectedDirectory $env:SMOKE_DIRECTORY
    $caKey=[Security.Cryptography.RSA]::Create(3072)
    $key=[Security.Cryptography.RSA]::Create(3072)
    try {
      $req=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Disposable BrowserSkills smoke CA',$caKey,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
      $req.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
      $ca=$req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddDays(2))
      $cert=New-ServerCertificate $key $ca ([Net.IPAddress]::Loopback) ([DateTimeOffset]::UtcNow.AddDays(1))
      Write-Utf8 (Join-Path $env:SMOKE_DIRECTORY 'ca_cert') $ca.ExportCertificatePem()
      Write-Utf8 (Join-Path $env:SMOKE_DIRECTORY 'api_cert') $cert.ExportCertificatePem()
      Write-Utf8 (Join-Path $env:SMOKE_DIRECTORY 'api_key') $key.ExportPkcs8PrivateKeyPem()
      $cert.Dispose(); $ca.Dispose()
    } finally { $key.Dispose(); $caKey.Dispose() }
  `],undefined,{SMOKE_DIRECTORY:directory});
  for(const name of ['db_password','postgres_password','worker_1_token','worker_2_token','worker_3_token','worker_4_token','worker_5_token'])await writeFile(join(directory,name),password);
  await writeFile(join(directory,'init.sh'),(await readFile('ops/postgres/init.sh','utf8')).replaceAll('\r\n','\n'));
  await command('docker',['network','create',network]);networkCreated=true;
  await command('docker',['run','--detach','--rm','--name',postgres,'--network',network,'--env','POSTGRES_DB=browserskills','--env','POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password',...mount('postgres_password'),...mount('db_password'),'--mount',`type=bind,source=${join(directory,'init.sh')},target=/docker-entrypoint-initdb.d/10-browserskills.sh,readonly`,'postgres:17.9-bookworm@sha256:47f917f7409eacd22fc5dfb1dee634e1b55cf0c01d1a7eb701be2227a03e0641']);containers.push(postgres);
  let databaseReady=false;
  for(let attempt=0;attempt<60;attempt++){
    try{await command('docker',['exec',postgres,'pg_isready','-h','127.0.0.1','-U','postgres','-d','browserskills']);databaseReady=true;break;}catch{}
    await new Promise(done=>setTimeout(done,500));
  }
  assert(databaseReady,'PostgreSQL startup timed out');
  const workerSettings=Array.from({length:5},(_,i)=>['--env',`API_WORKER_${i+1}_URL=http://127.0.0.1:1`,...mount(`worker_${i+1}_token`)]).flat();
  await command('docker',['run','--detach','--rm','--init','--name',api,'--network',network,'--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--memory','2g','--pids-limit','256','--tmpfs','/tmp:size=268435456,mode=1777','--publish','127.0.0.1::8443','--env',`BROWSERSKILLS_DB_URL=jdbc:postgresql://${postgres}:5432/browserskills`,'--env','BROWSERSKILLS_DB_USERNAME=browserskills','--env','BROWSERSKILLS_PUBLIC_ORIGIN=https://127.0.0.1:8443','--env','API_INFERENCE_URL=http://127.0.0.1:1',...mount('db_password'),...mount('api_cert'),...mount('api_key'),...mount('ca_cert'),...workerSettings,process.env.API_DOCKER_IMAGE??'browserskills-api:local']);containers.push(api);
  const port=Number((await command('docker',['port',api,'8443/tcp'])).split(':').at(-1));
  const ca=await readFile(join(directory,'ca_cert'));
  let cookie='';
  const cookies:string[]=[];
  async function request(path:string,method='GET',body?:unknown,headers:RequestOptions['headers']={}){
    return new Promise<{status:number;body:string;headers:import('node:http').IncomingHttpHeaders}>((done,reject)=>{
      const data=body===undefined?undefined:JSON.stringify(body);
      const request=httpsRequest({hostname:'127.0.0.1',port,path,method,ca,rejectUnauthorized:true,timeout:10_000,headers:{...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{}),...headers}},response=>{
        let text='';
        response.on('data',chunk=>{text+=chunk;if(text.length>2*1024*1024)response.destroy(new Error('Response exceeded smoke limit'));});
        response.once('error',reject);
        response.once('end',()=>{for(const value of response.headers['set-cookie']??[]){cookies.push(value);cookie=value.split(';')[0];}done({status:response.statusCode??0,body:text,headers:response.headers});});
      });
      request.once('error',reject);request.once('timeout',()=>request.destroy(new Error('HTTPS timeout')));request.end(data);
    });
  }
  let live=false;
  for(let attempt=0;attempt<90;attempt++){
    try{if((await request('/health/live')).status===200){live=true;break;}}catch{}
    await new Promise(done=>setTimeout(done,500));
  }
  if(!live)throw new Error(`Production TLS startup failed: ${await command('docker',['logs','--tail','80',api])}`);
  const index=await request('/');assert.equal(index.status,200);assert.match(index.body,/<div id="root"/);
  assert.match(String(index.headers['content-security-policy']),/frame-ancestors 'none'/);
  const script=index.body.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];assert(script,'Production JS asset missing');assert.equal((await request(script)).status,200);
  assert.equal((await request('/api/me')).status,401);
  assert.equal((await request('/health/ready')).status,404,'Readiness must stay private');
  const readiness=JSON.parse(await command('docker',['exec',api,'curl','--fail','--silent','--max-time','10','--cacert','/run/secrets/ca_cert','https://127.0.0.1:8443/health/ready']));
  assert.equal(readiness.status,'DEGRADED');assert.equal(readiness.components.database,'UP');assert.equal(readiness.components.inference,'DOWN');assert.equal(readiness.manualReviewAvailable,false);
  for(let i=1;i<=5;i++)assert.equal(readiness.components[`browser-${i}`],'DOWN');
  await command('docker',['exec','-i',api,'java','-jar','/app/api.jar','--spring.main.web-application-type=none','--spring.profiles.active=admin','--create-user=smoke'],password+'\n');
  assert.equal((await request('/api/auth/login','POST',{login:'smoke',password})).status,403,'CSRF is required');
  const csrf=JSON.parse((await request('/api/auth/csrf')).body);const previousCookie=cookie;
  const login=await request('/api/auth/login','POST',{login:'smoke',password},{[csrf.headerName]:csrf.token});assert.equal(login.status,200);assert.equal(JSON.parse(login.body).login,'smoke');assert.notEqual(cookie,previousCookie);
  assert(cookies.some(value=>/; Secure/i.test(value)&&/; HttpOnly/i.test(value)&&/SameSite=Lax/i.test(value)),'Secure session attributes missing');
  assert.equal(JSON.parse((await request('/api/me')).body).login,'smoke');
  const logoutCsrf=JSON.parse((await request('/api/auth/csrf')).body);
  assert.equal((await request('/api/auth/logout','POST',undefined,{[logoutCsrf.headerName]:logoutCsrf.token})).status,204);
  assert.equal((await request('/api/me')).status,401);
  assert.equal(await command('docker',['exec',api,'id','-u']),'10001');
  await command('docker',['exec',api,'ffmpeg','-version']);await command('docker',['exec',api,'ffprobe','-version']);
  console.log('Production Docker API passed: non-root/read-only, PostgreSQL app role, verified TLS/IP SAN, embedded web assets, private readiness, secure cookie/CSRF/login/logout and FFmpeg tools. Browser/model endpoints were deliberately unavailable.');
}finally{
  for(const container of containers.toReversed())try{await command('docker',['rm','--force',container]);}catch(error){console.error('Fixture container cleanup failed:',error);}
  if(networkCreated)await command('docker',['network','rm',network]);
  if(!resolve(directory).startsWith(resolve(base)+sep))throw new Error('Fixture cleanup path escaped workspace');
  await rm(directory,{recursive:true,force:true});
}
