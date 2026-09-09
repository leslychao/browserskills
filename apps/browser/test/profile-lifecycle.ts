/** Owned cookie/storage fixture, mounted only by the isolated Docker profile tests. */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { BrowserOwner } from '../src/owner.js';
import { createWorkerServer } from '../src/server.js';

const workerId=process.env.WORKER_ID??'';
const mode=process.env.PROFILE_TEST_MODE;
const marker=process.env.PROFILE_TEST_MARKER??'';
if(!/^browser-[1-5]$/.test(workerId)||!['seed','read'].includes(mode??'')||!/^[-a-zA-Z0-9]{8,100}$/.test(marker))throw new Error('Invalid profile fixture configuration');
const token=process.env.WORKER_TOKEN_FILE?(await readFile(process.env.WORKER_TOKEN_FILE,'utf8')).trim():'disposable-profile-fixture-token-123456789';
const site=createServer(async(request,response)=>{
  try{
    if(request.method==='GET'&&request.url==='/'){
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',...(mode==='seed'?{'Set-Cookie':`profile_marker=${marker}; Path=/; Max-Age=2592000; SameSite=Strict; HttpOnly`}:{})});
      response.end(`<!doctype html><html><title>Owned profile lifecycle fixture</title><body><p>Browser profile persistence check</p><script>
        ${mode==='seed'?`localStorage.setItem('profile_marker',${JSON.stringify(marker)});`:''}
        fetch('/evidence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stored:localStorage.getItem('profile_marker')})});
      </script></body></html>`);
      return;
    }
    if(request.method==='POST'&&request.url==='/evidence'){
      let body='';for await(const chunk of request){body+=String(chunk);if(body.length>1024)throw new Error('Oversized fixture evidence');}
      const stored=(JSON.parse(body) as {stored?:unknown}).stored;
      const cookie=request.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith('profile_marker='))?.slice('profile_marker='.length)??null;
      const evidence={workerId,mode,expectedMarker:marker,stored,cookie,match:stored===marker&&cookie===marker,recordedAt:new Date().toISOString()};
      await writeFile('/tmp/profile-evidence.json',JSON.stringify(evidence));
      response.writeHead(204);response.end();return;
    }
    response.writeHead(404);response.end();
  }catch{response.writeHead(500);response.end();}
});
site.listen(4100,'127.0.0.1');await once(site,'listening');
const owner=new BrowserOwner({workerId,profileDir:'/data/profile',mediaDir:'/run/browser/media',headless:false,startUrl:'http://127.0.0.1:4100/'});
const application=createWorkerServer(owner,token,Number(process.env.RFB_PORT??5900));
application.server.listen(3000,'0.0.0.0');await once(application.server,'listening');
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void application.close().then(()=>new Promise<void>(done=>site.close(()=>done()))).then(()=>process.exit(0));});
await owner.command({id:randomUUID(),type:'OPEN'});
