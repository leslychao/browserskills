/** Explicit Linux integration smoke: actual TigerVNC display -> Chromium -> authenticated bridge. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { WebSocket } from 'ws';
import { BrowserOwner } from '../src/owner.js';
import { createWorkerServer } from '../src/server.js';
import { startTestSite } from '../../../tests/test-site/server.js';

const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const directory=await mkdtemp(join(tmpdir(),'browserskills-rfb-'));
const fixture=await startTestSite();
const display=':98';const rfbPort=5901;process.env.DISPLAY=display;
const desktop=spawn('Xtigervnc',[display,'-geometry','1366x768','-depth','24','-localhost','-interface','127.0.0.1','-rfbport',String(rfbPort),'-SecurityTypes','None','-AlwaysShared','-AcceptSetDesktopSize=0','-SetPrimary=0','-SendPrimary=0','-MaxCutText=131072','-nolisten','tcp','-Log','*:stderr:0'],{stdio:'ignore'});
const owner=new BrowserOwner({workerId:'browser-1',profileDir:join(directory,'profile'),mediaDir:join(directory,'media'),headless:false,startUrl:fixture.url});
const token='live-rfb-fixture-token-at-least-thirty-two-characters';
const app=createWorkerServer(owner,token,rfbPort);
try{
  let ready=false;for(let i=0;i<50;i++){if(spawnSync('xdpyinfo',['-display',display],{stdio:'ignore'}).status===0){ready=true;break;}await delay(100);}assert(ready,'TigerVNC display did not start');
  ready=false;for(let i=0;i<50;i++){try{const socket=connect(rfbPort,'127.0.0.1');await once(socket,'connect');socket.destroy();ready=true;break;}catch{await delay(100);}}assert(ready,'TigerVNC RFB socket did not start');
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  await owner.command({id:randomUUID(),type:'OPEN'});await owner.command({id:randomUUID(),type:'ENTER_MANUAL'});
  const url=`ws://127.0.0.1:${(app.server.address() as import('node:net').AddressInfo).port}/internal/view`;
  const ws=new WebSocket(url,{headers:{Authorization:`Bearer ${token}`}});
  let buffered=Buffer.alloc(0);let wake:(()=>void)|undefined;
  ws.on('message',data=>{buffered=Buffer.concat([buffered,Buffer.from(data as Buffer)]);wake?.();});
  const read=async(count:number)=>{const deadline=Date.now()+5000;while(buffered.length<count){assert(Date.now()<deadline,'RFB protocol timed out');await Promise.race([new Promise<void>(resolve=>{wake=resolve;}),delay(50)]);}const value=buffered.subarray(0,count);buffered=buffered.subarray(count);return value;};
  await once(ws,'open');const version=await read(12);assert(version.toString().startsWith('RFB 003.'));ws.send(Buffer.from('RFB 003.008\n'));
  const types=await read(1);const offered=await read(types[0]!);assert(offered.includes(1),'Expected localhost TigerVNC None auth behind bearer bridge');ws.send(Buffer.from([1]));assert.equal((await read(4)).readUInt32BE(0),0);ws.send(Buffer.from([1]));
  const init=await read(24);assert(init.readUInt16BE(0)>0);assert(init.readUInt16BE(2)>0);const nameLength=init.readUInt32BE(20);assert(nameLength<4096);await read(nameLength);
  const key=(keysym:number,down:boolean)=>{const bytes=Buffer.alloc(8);bytes[0]=4;bytes[1]=down?1:0;bytes.writeUInt32BE(keysym,4);ws.send(bytes);};
  key(0xffe3,true);key(0x6c,true);key(0x6c,false);key(0xffe3,false);await delay(150);
  for(const character of fixture.url+'/#rfb-authorized'){const code=character.charCodeAt(0);key(code,true);key(code,false);}
  key(0xff0d,true);key(0xff0d,false);
  const deadline=Date.now()+5000;while(!owner.status().url?.endsWith('#rfb-authorized')&&Date.now()<deadline)await delay(50);
  assert(owner.status().url?.endsWith('#rfb-authorized'),'Real RFB keyboard input did not reach Chromium');
  const closed=once(ws,'close');await owner.command({id:randomUUID(),type:'BEGIN',generation:owner.status().generation!,runId:randomUUID()});await closed;
  assert.equal(ws.readyState,WebSocket.CLOSED);assert.equal(owner.status().mode,'AUTOMATION');
  const denied=new WebSocket(url,{headers:{Authorization:`Bearer ${token}`}});await assert.rejects(once(denied,'open'));
  process.stdout.write(JSON.stringify({tigerVnc:true,chromiumSandbox:true,authenticatedBinaryRfb:true,realKeyboardInput:true,revokedBeforeAutomation:true})+'\n');
}finally{await app.close();desktop.kill();await fixture.close();await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
