import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { WorkerCommandSchema } from '@browserskills/contracts';
import { BrowserOwner } from './owner.js';
import { WorkerError, errorBody } from './errors.js';
import { parseRange } from './media.js';

export function createWorkerServer(owner:BrowserOwner,token:string,rfbPort=5900){
  if(Buffer.byteLength(token)<32)throw new WorkerError('TOKEN_TOO_SHORT',500);
  const expected=Buffer.from(`Bearer ${token}`);
  const authorized=(request:IncomingMessage)=>{const value=Buffer.from(request.headers.authorization??'');return value.length===expected.length&&timingSafeEqual(value,expected);};
  const json=(response:ServerResponse,status:number,body:unknown)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(body));};
  let activeRequests=0;
  const server=createServer(async(request,response)=>{
    try{
      const path=new URL(request.url??'/', 'http://worker').pathname;
      if(request.method==='GET'&&path==='/health/live'){json(response,200,{status:'UP'});return;}
      if(!authorized(request))throw new WorkerError('UNAUTHORIZED',401);
      if(activeRequests>=16)throw new WorkerError('WORKER_BUSY',429);
      activeRequests++;
      try{
        if(request.method==='GET'&&path==='/internal/status'){json(response,200,owner.status());return;}
        if(request.method==='POST'&&path==='/internal/commands'){
          if(!request.headers['content-type']?.startsWith('application/json'))throw new WorkerError('UNSUPPORTED_CONTENT_TYPE',415);
          let body='';for await(const chunk of request){body+=String(chunk);if(Buffer.byteLength(body)>16_384)throw new WorkerError('REQUEST_TOO_LARGE',413);}
          let parsed:unknown;try{parsed=JSON.parse(body);}catch{throw new WorkerError('INVALID_COMMAND',400);}
          const command=WorkerCommandSchema.safeParse(parsed);if(!command.success)throw new WorkerError('INVALID_COMMAND',400);
          json(response,200,await owner.command(command.data));return;
        }
        if(request.method==='GET'&&path.startsWith('/internal/media/')){
          const id=path.slice('/internal/media/'.length);if(!/^[a-f0-9-]{36}$/.test(id))throw new WorkerError('NOT_FOUND',404);
          const metadata=owner.media.metadata(id);const bytes=await owner.media.read(id);let range;
          try{range=parseRange(request.headers.range,bytes.length);}catch(error){response.setHeader('Content-Range',`bytes */${bytes.length}`);throw error;}
          response.writeHead(range?206:200,{'Content-Type':metadata.mimeType,'Content-Length':range?range.end-range.start+1:bytes.length,'Cache-Control':'no-store','Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff',...(range?{'Content-Range':`bytes ${range.start}-${range.end}/${bytes.length}`}:{})});
          response.end(range?bytes.subarray(range.start,range.end+1):bytes);return;
        }
        throw new WorkerError('NOT_FOUND',404);
      }finally{activeRequests--;}
    }catch(error){if(!response.headersSent)json(response,error instanceof WorkerError?error.status:500,errorBody(error));else response.destroy();}
  });
  server.requestTimeout=180_000;server.headersTimeout=10_000;server.keepAliveTimeout=5_000;server.maxHeadersCount=30;
  const bridge=new WebSocketServer({noServer:true,maxPayload:64*1024,perMessageDeflate:false});
  const revoke=()=>{for(const socket of bridge.clients)socket.terminate();};owner.on('revoke',revoke);
  server.on('upgrade',(request,socket,head)=>{
    const path=new URL(request.url??'/', 'http://worker').pathname;
    if(path!=='/internal/view'||!authorized(request)||!owner.isManual()||bridge.clients.size>=1){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    bridge.handleUpgrade(request,socket,head,ws=>bridge.emit('connection',ws,request));
  });
  bridge.on('connection',ws=>{
    const generation=owner.status().generation!;
    if(!owner.isManual(generation)){ws.terminate();return;}
    const tcp=connect({host:'127.0.0.1',port:rfbPort});
    const close=()=>{tcp.destroy();ws.terminate();};
    const expiry=setTimeout(close,60*60*1000);expiry.unref();
    ws.on('message',(data,isBinary)=>{
      if(!owner.isManual(generation)||!isBinary||tcp.writableLength>1024*1024){close();return;}
      tcp.write(Array.isArray(data)?Buffer.concat(data):Buffer.from(data as Buffer));
    });
    tcp.on('data',data=>{
      if(!owner.isManual(generation)||ws.readyState!==WebSocket.OPEN||ws.bufferedAmount>4*1024*1024){close();return;}
      tcp.pause();ws.send(data,{binary:true},error=>{if(error)close();else tcp.resume();});
    });
    tcp.on('error',close);tcp.on('close',()=>ws.terminate());ws.on('error',close);ws.on('close',()=>{clearTimeout(expiry);tcp.destroy();});
  });
  return {server,close:async()=>{owner.off('revoke',revoke);revoke();bridge.close();await owner.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
