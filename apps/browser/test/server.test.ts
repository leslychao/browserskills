import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { request } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { BrowserOwner } from '../src/owner.js';
import { createWorkerServer } from '../src/server.js';
import { startYangFixture, type YangFixtureMode } from './yang-fixture.js';
import type { BrowserStatus, TaskSet, WorkerCommand } from '@browserskills/contracts';

const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
const token='worker-test-secret-with-more-than-thirty-two-characters';
async function setup(mode:YangFixtureMode='normal'){
  const site=await startYangFixture(mode);cleanup.push(site.close);
  const directory=await mkdtemp(join(tmpdir(),'browserskills-worker-'));cleanup.push(()=>rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  const owner=new BrowserOwner({workerId:'browser-1',profileDir:join(directory,'profile'),mediaDir:join(directory,'media'),headless:true,startUrl:`${site.url}/task/${site.pool}/suite-1`,adapterOptions:{origin:site.url,frameOrigin:site.url,mediaOrigins:[site.url],instructionOrigins:[site.url]},verificationTimeoutMs:250});
  const input:Buffer[]=[];const tcp=createTcpServer(socket=>{socket.write('RFB 003.008\n');socket.on('data',data=>{input.push(data);socket.write(data);});});
  tcp.listen(0,'127.0.0.1');await once(tcp,'listening');cleanup.push(()=>new Promise<void>(resolve=>tcp.close(()=>resolve())));
  const app=createWorkerServer(owner,token,(tcp.address() as import('node:net').AddressInfo).port);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');cleanup.push(app.close);
  const url=`http://127.0.0.1:${(app.server.address() as import('node:net').AddressInfo).port}`;
  type Input=WorkerCommand extends infer C?C extends WorkerCommand?Omit<C,'id'>&{id?:string}:never:never;
  const command=async(command:Input)=>fetch(`${url}/internal/commands`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({id:randomUUID(),...command})});
  return {owner,app,url,command,input,site};
}

describe('worker HTTP, generation and manual control',()=>{
  it('closes admission before browser shutdown, rejects an unfinished OPEN body and closes only once',async()=>{
    const {owner,app,url}=await setup();
    let releaseClose!:()=>void;
    const ownerClosing=new Promise<void>(resolve=>{releaseClose=resolve;});
    const closeOwner=vi.spyOn(owner,'close').mockImplementation(()=>ownerClosing);
    const dispatch=vi.spyOn(owner,'command');
    const body=JSON.stringify({id:randomUUID(),type:'OPEN'});
    const received=once(app.server,'request');
    let responseResult!:Promise<{status:number|undefined;body:string}>;
    const pending=request(`${url}/internal/commands`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}});
    responseResult=new Promise((resolve,reject)=>{pending.once('error',reject);pending.once('response',response=>{let body='';response.on('data',chunk=>{body+=String(chunk);});response.once('end',()=>resolve({status:response.statusCode,body}));});});
    void responseResult.catch(()=>undefined);
    pending.write(body.slice(0,5));await received;
    const closing=app.close();
    try{
      expect(app.close()).toBe(closing);
      expect(app.server.listening).toBe(false);
      await expect(fetch(`${url}/internal/commands`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body,signal:AbortSignal.timeout(2000)})).rejects.toThrow();
      pending.end(body.slice(5));
      expect(await responseResult).toEqual({status:503,body:JSON.stringify({code:'WORKER_CLOSING',message:'WORKER_CLOSING'})});
      expect(dispatch).not.toHaveBeenCalled();expect(closeOwner).toHaveBeenCalledTimes(1);
    }finally{pending.destroy();releaseClose();await closing;}
  });
  it('requires bearer for status, commands and original media',async()=>{
    const {url}=await setup();
    for(const path of ['/internal/status','/internal/media/'+randomUUID(),'/internal/commands'])expect((await fetch(url+path)).status).toBe(401);
    expect((await fetch(url+'/health/live')).status).toBe(200);
    expect((await fetch(url+'/internal/status',{headers:{Authorization:'Bearer wrong'}})).status).toBe(401);
    expect((await fetch(url+'/unknown',{headers:{Authorization:`Bearer ${token}`}})).status).toBe(404);
  });
  it('deduplicates command IDs and rejects changed payload and stale generations',async()=>{
    const {command}=await setup();const id=randomUUID();
    const first=await (await command({type:'OPEN',id})).json() as BrowserStatus;
    expect(await (await command({type:'OPEN',id})).json()).toEqual(first);
    expect((await command({type:'ENTER_MANUAL',id})).status).toBe(409);
    expect((await command({type:'BEGIN',generation:'old',runId:randomUUID()})).status).toBe(409);
    const runId=randomUUID();expect((await command({type:'BEGIN',generation:first.generation!,runId})).status).toBe(200);
    expect((await command({type:'ENTER_MANUAL'})).status).toBe(409);
    expect((await command({type:'SNAPSHOT',generation:first.generation!,runId:randomUUID()})).status).toBe(409);
    const snapshotCommand={type:'SNAPSHOT' as const,id:randomUUID(),generation:first.generation!,runId};
    const snapshot=await(await command(snapshotCommand)).json() as TaskSet;
    expect(snapshot.suiteId).toBe('suite-1');
    const stop=await(await command({type:'STOP',generation:first.generation!,runId})).json() as BrowserStatus;
    expect(stop.mode).toBe('CLOSED');expect(stop.generation).not.toBe(first.generation);
    expect(await(await command(snapshotCommand)).json()).toMatchObject({code:'COMMAND_EXPIRED'});
    expect((await command({type:'SNAPSHOT',generation:first.generation!,runId})).status).toBe(409);
  });
  it('revokes an already connected RFB input socket before automation begins',async()=>{
    const {url,command,input}=await setup();
    const status=await(await command({type:'OPEN'})).json() as BrowserStatus;
    await command({type:'ENTER_MANUAL',generation:status.generation!});
    const socket=new WebSocket(url.replace('http:','ws:')+'/internal/view',{headers:{Authorization:`Bearer ${token}`}});
    const greeting=once(socket,'message');await once(socket,'open');expect(String((await greeting)[0])).toBe('RFB 003.008\n');
    const echo=once(socket,'message');socket.send(Buffer.from([5,1,2]));expect(Buffer.from((await echo)[0] as Buffer)).toEqual(Buffer.from([5,1,2]));
    const closed=once(socket,'close');await command({type:'BEGIN',generation:status.generation!,runId:randomUUID()});await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);expect(input).toHaveLength(1);
    const denied=new WebSocket(url.replace('http:','ws:')+'/internal/view',{headers:{Authorization:`Bearer ${token}`}});await expect(once(denied,'open')).rejects.toThrow();
  });
  it('rejects websocket without token, closes text input and releases manual control',async()=>{
    const {url,command}=await setup();await command({type:'OPEN'});await command({type:'ENTER_MANUAL'});
    const unauthorized=new WebSocket(url.replace('http:','ws:')+'/internal/view');await expect(once(unauthorized,'open')).rejects.toThrow();
    const socket=new WebSocket(url.replace('http:','ws:')+'/internal/view',{headers:{Authorization:`Bearer ${token}`}});await once(socket,'open');const closed=once(socket,'close');socket.send('text is not RFB');await closed;
    const released=await(await command({type:'EXIT_MANUAL'})).json() as BrowserStatus;expect(released.mode).toBe('IDLE');
  });
  it('pause releases automation for user login and resumes in the same persistent browser',async()=>{
    const {command,site}=await setup();const status=await(await command({type:'OPEN'})).json() as BrowserStatus;
    const runId=randomUUID();const generation=status.generation!;await command({type:'BEGIN',generation,runId});
    expect(await(await command({type:'PAUSE',generation,runId})).json()).toMatchObject({mode:'IDLE',generation});
    expect((await command({type:'ENTER_MANUAL',generation})).status).toBe(200);
    expect((await command({type:'BEGIN',generation,runId})).status).toBe(200);
    expect(site.state.submissions).toHaveLength(0);
  });
  it('serves bounded original bytes with Range and makes cleared IDs inaccessible',async()=>{
    const {owner,url}=await setup();const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=','base64');
    const asset=await owner.media.put(bytes,'image');const headers={Authorization:`Bearer ${token}`};
    expect(Buffer.from(await(await fetch(`${url}/internal/media/${asset.id}`,{headers})).arrayBuffer())).toEqual(bytes);
    const partial=await fetch(`${url}/internal/media/${asset.id}`,{headers:{...headers,Range:'bytes=0-9'}});
    expect(partial.status).toBe(206);expect(partial.headers.get('content-range')).toBe(`bytes 0-9/${bytes.length}`);
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(bytes.subarray(0,10));
    expect((await fetch(`${url}/internal/media/${asset.id}`,{headers:{...headers,Range:'bytes=1000-1001'}})).status).toBe(416);
    expect((await fetch(`${url}/internal/media/../../private`,{headers})).status).toBe(404);
    await owner.media.clear();expect((await fetch(`${url}/internal/media/${asset.id}`,{headers})).status).toBe(404);
  });
  it('dispatches the complete autonomous mapping workflow through the authenticated worker API',async()=>{
    const {command,url}=await setup('opaque');expect((await command({type:'YANG_SESSION'})).status).toBe(409);expect((await command({type:'CATALOGUE',payload:{refresh:false}})).status).toBe(409);
    const status=await(await command({type:'OPEN'})).json() as BrowserStatus;expect((await fetch(`${url}/internal/status`,{headers:{Authorization:`Bearer ${token}`}})).status).toBe(200);expect(await(await command({type:'YANG_SESSION'})).json()).toMatchObject({state:'READY'});
    const generation=status.generation!,runId=randomUUID();await command({type:'BEGIN',generation,runId});expect((await command({type:'CATALOGUE',payload:{refresh:true}})).status).toBe(200);expect((await command({type:'INSTRUCTION',generation,runId,payload:{poolId:'123'}})).status).toBe(200);expect(await(await command({type:'SELECT_PROJECT',generation,runId,payload:{poolId:'123'}})).json()).toMatchObject({workerId:'browser-1',generation,mode:'AUTOMATION',runId,yang:{state:'READY',poolId:'123',suiteId:'suite-1'}});
    let task=await(await command({type:'SNAPSHOT',generation,runId})).json() as TaskSet;task=await(await command({type:'MAP_FIELDS',generation,runId,payload:{suiteId:task.suiteId,snapshotHash:task.snapshotHash,groups:[{partId:'part-1',fieldId:'choice',label:'Preference',kind:'SINGLE_CHOICE',controlIds:task.parts[0]!.unmappedControls.map(c=>c.id)}]}})).json() as TaskSet;
    const answers=[{partId:'part-1',fieldId:'choice',value:task.parts[0]!.fields[0]!.options[0]!.id}];task=await(await command({type:'APPLY',generation,runId,payload:{poolId:task.poolId,suiteId:task.suiteId,snapshotHash:task.snapshotHash,instructionHash:task.instruction.hash,answers}})).json() as TaskSet;
    expect(await(await command({type:'SUBMIT',generation,runId,payload:{poolId:task.poolId,suiteId:task.suiteId,snapshotHash:task.snapshotHash,instructionHash:task.instruction.hash,answers}})).json()).toMatchObject({outcome:'SUBMITTED'});
  });
});
