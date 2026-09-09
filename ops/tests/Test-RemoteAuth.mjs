/** Auth/status smoke for the new deployment, before interactive user sessions.
 * No browser OPEN/manual-control requests, RFB interaction or Yandex actions.
 * Password and cookies remain in process memory and are never printed.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { resolve, join } from 'node:path';

const directory=resolve(process.argv[2]??'');
if(!process.argv[2])throw new Error('Pass the protected remote deployment directory.');
const credentials=JSON.parse(await readFile(join(directory,'operator-credentials.json'),'utf8'));
const origin=new URL(credentials.origin);
assert.equal(origin.protocol,'http:');
assert.equal(origin.port,'8080');
let cookie='';
let sawSession=false;
const evidence={startedAtUtc:new Date().toISOString(),origin:origin.origin,passed:false};
async function request(path,method='GET',body,headers={}){
  const serialized=body===undefined?undefined:JSON.stringify(body);
  return new Promise((done,reject)=>{
    const request=httpRequest(new URL(path,origin),{method,timeout:10000,headers:{...(cookie?{Cookie:cookie}:{}),...(serialized?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(serialized)}:{}),...headers}},response=>{
      const chunks=[];let length=0;
      response.on('data',chunk=>{length+=chunk.length;if(length>2*1024*1024){response.destroy(new Error('Response exceeded smoke limit.'));return;}chunks.push(chunk);});
      response.once('error',reject);
      response.once('end',()=>{
        for(const value of response.headers['set-cookie']??[]){
          if(value.startsWith('BROWSERSKILLS_SESSION=')){
            cookie=value.split(';')[0];
            assert(!/; Secure/i.test(value),'Explicit LAN HTTP deployment cannot issue a Secure-only session cookie.');
            sawSession ||= /; HttpOnly/i.test(value)&&/SameSite=Lax/i.test(value);
          }
        }
        done({status:response.statusCode,body:Buffer.concat(chunks).toString('utf8'),headers:response.headers});
      });
    });
    request.once('error',reject);request.once('timeout',()=>request.destroy(new Error('HTTP timeout.')));request.end(serialized);
  });
}
try{
  assert.equal((await request('/health/live')).status,200);
  const page=await request('/');assert.equal(page.status,200);assert.match(page.body,/<div id="root"/);
  assert.match(String(page.headers['content-security-policy']),/frame-ancestors 'none'/);
  const asset=page.body.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];assert(asset);assert.equal((await request(asset)).status,200);
  assert.equal((await request('/health/ready')).status,404);
  assert.equal((await request('/api/me')).status,401);
  assert.equal((await request('/api/auth/login','POST',{login:credentials.login,password:credentials.password})).status,403);
  const csrf=JSON.parse((await request('/api/auth/csrf')).body);
  const beforeLogin=cookie;
  const login=await request('/api/auth/login','POST',{login:credentials.login,password:credentials.password},{[csrf.headerName]:csrf.token});
  assert.equal(login.status,200);assert.equal(JSON.parse(login.body).login,credentials.login);assert.notEqual(cookie,beforeLogin);
  const me=JSON.parse((await request('/api/me')).body);assert.equal(me.login,credentials.login);
  const browser=await request('/api/browser');assert.equal(browser.status,200);
  const status=JSON.parse(browser.body);
  const runs=await request('/api/runs');assert.equal(runs.status,200);
  const logoutCsrf=JSON.parse((await request('/api/auth/csrf')).body);
  assert.equal((await request('/api/auth/logout','POST',undefined,{[logoutCsrf.headerName]:logoutCsrf.token})).status,204);
  assert.equal((await request('/api/me')).status,401);assert(sawSession);
  evidence.passed=true;
  evidence.checks={lanHttp:true,embeddedWebAssets:true,privateReadiness:true,anonymous401:true,csrfRequired:true,login:true,sessionRotated:true,httpOnlySameSiteCookieWithoutSecure:true,authenticatedStatus:true,logout:true};
  evidence.browser={workerId:status.workerId,mode:status.mode,generation:status.generation};
  evidence.historyCount=JSON.parse(runs.body).length;
}finally{
  credentials.password='';cookie='';
  evidence.finishedAtUtc=new Date().toISOString();
  await writeFile(join(directory,'auth-http-smoke-result.json'),JSON.stringify(evidence,null,2)+'\n');
}
console.log('Remote LAN HTTP/API auth smoke passed: web assets, CSRF/session/login/status/logout. No remote browser navigation or Yandex operation was performed.');
