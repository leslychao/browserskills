import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { BrowserContext, Frame } from 'playwright';
import type { MediaAsset } from '@browserskills/contracts';
import sharp from 'sharp';
import { WorkerError } from './errors.js';

const MAX_ASSET = 20 * 1024 * 1024;
// The API reserves a further 64 MiB working cache: the per-user total stays within 1 GiB.
const MAX_TOTAL = 960 * 1024 * 1024;
const AUDIO_FORMATS = 'wav,mp3,flac,ogg,matroska,webm,mov,mp4';
export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export interface StoredAsset { metadata: MediaAsset; path: string; }

/** Per-active-task temporary originals. No URLs or filenames are accepted by the read API. */
export class MediaStore {
  private readonly directory: string;
  private entries = new Map<string, StoredAsset>();
  private totalBytes = 0;
  private reservedBytes = 0;
  private epoch = 0;
  constructor(directory: string, private readonly ffprobe = process.env.FFPROBE_PATH || 'ffprobe') { this.directory = resolve(directory); }

  async initialize():Promise<void>{
    await mkdir(this.directory,{recursive:true,mode:0o700});
    // This is a dedicated media volume. Never recurse or touch the persistent Chromium profile.
    for(const entry of await readdir(this.directory,{withFileTypes:true}))if(entry.isFile()&&/^[a-f0-9-]{36}$/.test(entry.name))await unlink(join(this.directory,entry.name));
    this.entries.clear();this.totalBytes=0;this.epoch++;
  }

  async put(bytes: Buffer, kind: 'image'|'audio', audioLimitMs = 60_000): Promise<MediaAsset> {
    const epoch=this.epoch;
    if (!bytes.length || bytes.length > MAX_ASSET) throw new WorkerError('MEDIA_TOO_LARGE', 422);
    const hash = sha256(bytes);
    const existing = [...this.entries.values()].find(entry => entry.metadata.sha256 === hash && entry.metadata.kind === kind);
    if (existing) {
      if (kind === 'audio' && existing.metadata.durationMs! > audioLimitMs) throw new WorkerError('AUDIO_TOO_LONG', 422);
      return existing.metadata;
    }
    if(this.totalBytes+this.reservedBytes+bytes.length>MAX_TOTAL)throw new WorkerError('MEDIA_TOO_LARGE',422);
    this.reservedBytes+=bytes.length;
    const id=randomUUID(); const path=join(this.directory,id);
    try {
      await mkdir(this.directory, {recursive:true, mode:0o700});
      await writeFile(path,bytes,{flag:'wx',mode:0o600});
      let mimeType:string; let durationMs:number|undefined;
      if(kind==='image') {
        const metadata=await sharp(bytes,{limitInputPixels:40_000_000,animated:true}).metadata();
        if(!metadata.width || !metadata.height || metadata.width>8192 || metadata.height>8192 || (metadata.pages??1)>1) throw new WorkerError('UNSUPPORTED_IMAGE',422);
        const formats:Record<string,string>={png:'image/png',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'};
        mimeType=formats[metadata.format??'']!;
        if(!mimeType) throw new WorkerError('UNSUPPORTED_IMAGE',422);
      } else {
        const magic=bytes.toString('ascii',0,4);
        const recognized=(magic==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE')||magic==='fLaC'||magic==='OggS'
          ||bytes.toString('ascii',0,3)==='ID3'||(bytes[0]===0xff&&(bytes[1]!&0xe0)===0xe0)
          ||bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))||bytes.toString('ascii',4,8)==='ftyp';
        if(!recognized)throw new WorkerError('UNSUPPORTED_AUDIO',422);
        const metadata=await this.probe(path);
        const streams=metadata.streams;
        if(!Array.isArray(streams) || streams.length!==1 || streams[0]?.codec_type!=='audio'
          || !Number.isInteger(streams[0].channels) || streams[0].channels<1 || streams[0].channels>2) throw new WorkerError('UNSUPPORTED_AUDIO',422);
        // Decode the entire bounded clip: container duration can be missing or misleading (e.g. WebM).
        durationMs=await this.decodedDuration(path,audioLimitMs);
        const format=String(metadata.format?.format_name??'');
        mimeType=format==='wav'?'audio/wav':format==='mp3'?'audio/mpeg':format==='flac'?'audio/flac':format==='ogg'?'audio/ogg'
          :format.includes('webm')?'audio/webm':format.includes('mov')?'audio/mp4':'';
        if(!mimeType) throw new WorkerError('UNSUPPORTED_AUDIO',422);
      }
      if(epoch!==this.epoch)throw new WorkerError('STOPPED');
      const metadata:MediaAsset={id,kind,mimeType,byteLength:bytes.length,sha256:hash,...(durationMs?{durationMs}:{})};
      this.entries.set(id,{metadata,path}); this.totalBytes+=bytes.length; return metadata;
    } catch(error) {
      await unlink(path).catch(()=>undefined);
      throw error instanceof WorkerError ? error : new WorkerError(kind==='audio'?'UNSUPPORTED_AUDIO':'UNSUPPORTED_IMAGE',422);
    }finally{this.reservedBytes-=bytes.length;}
  }

  private decodedDuration(path:string,limitMs:number):Promise<number>{
    return new Promise((resolvePromise,reject)=>{
      const child=spawn(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-xerror','-err_detect','explode','-protocol_whitelist','file,pipe','-format_whitelist',AUDIO_FORMATS,'-i',path,'-map','0:a:0','-vn','-sn','-dn','-ac','1','-ar','16000','-f','s16le','pipe:1'],{windowsHide:true,stdio:['ignore','pipe','ignore']});
      let bytes=0;let settled=false;
      const finish=(error?:WorkerError)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else if(!bytes)reject(new WorkerError('UNSUPPORTED_AUDIO',422));else resolvePromise(Math.ceil(bytes/32));};
      const timer=setTimeout(()=>{child.kill();finish(new WorkerError('MEDIA_PROBE_TIMEOUT',422));},30_000);
      child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>limitMs*32){child.kill();finish(new WorkerError('AUDIO_TOO_LONG',422));}});
      child.on('error',()=>finish(new WorkerError('MEDIA_PROBE_UNAVAILABLE',503)));
      child.on('close',code=>finish(code===0?undefined:new WorkerError('UNSUPPORTED_AUDIO',422)));
    });
  }

  private probe(path:string):Promise<{streams?:Array<{codec_type?:string;channels:number}>;format?:{duration?:string;format_name?:string}}> {
    return new Promise((resolvePromise,reject)=>{
      const child=spawn(this.ffprobe,['-v','error','-protocol_whitelist','file,pipe','-format_whitelist',AUDIO_FORMATS,'-show_entries','stream=codec_type,channels:format=duration,format_name','-of','json',path],{windowsHide:true,stdio:['ignore','pipe','ignore']});
      let output=''; let settled=false;
      const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else{try{resolvePromise(JSON.parse(output));}catch{reject(new WorkerError('UNSUPPORTED_AUDIO',422));}}};
      const timer=setTimeout(()=>{child.kill();finish(new WorkerError('MEDIA_PROBE_TIMEOUT',422));},10_000);
      child.stdout.on('data',part=>{output+=String(part);if(output.length>16_384){child.kill();finish(new WorkerError('UNSUPPORTED_AUDIO',422));}});
      child.on('error',()=>finish(new WorkerError('MEDIA_PROBE_UNAVAILABLE',503)));
      child.on('close',code=>finish(code===0?undefined:new WorkerError('UNSUPPORTED_AUDIO',422)));
    });
  }

  metadata(id:string):MediaAsset {const entry=this.entries.get(id);if(!entry)throw new WorkerError('NOT_FOUND',404);return entry.metadata;}
  async read(id:string):Promise<Buffer> {const entry=this.entries.get(id);if(!entry)throw new WorkerError('NOT_FOUND',404);return readFile(entry.path);}
  stream(id:string,range:ByteRange|null=null){const entry=this.entries.get(id);if(!entry)throw new WorkerError('NOT_FOUND',404);return createReadStream(entry.path,{highWaterMark:64*1024,...(range?{start:range.start,end:range.end}:{})});}
  async retain(ids:Set<string>):Promise<void> {
    for(const [id,entry] of this.entries) if(!ids.has(id)){this.entries.delete(id);this.totalBytes-=entry.metadata.byteLength;await unlink(entry.path).catch(()=>undefined);}
  }
  async clear():Promise<void> {this.epoch++;await this.retain(new Set());}
}

export interface ByteRange { start:number; end:number; }
export function parseRange(header:string|undefined,total:number):ByteRange|null {
  if(!header) return null;
  const match=/^bytes=(\d*)-(\d*)$/.exec(header);
  if(!match || (!match[1]&&!match[2]))throw new WorkerError('RANGE_NOT_SATISFIABLE',416);
  const start=match[1]?Number(match[1]):Math.max(0,total-Number(match[2]));
  const end=match[1]?(match[2]?Math.min(Number(match[2]),total-1):total-1):total-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=total||end<start||(!match[1]&&Number(match[2])===0))throw new WorkerError('RANGE_NOT_SATISFIABLE',416);
  return {start,end};
}

/** Fetch the selected media only, with browser cookies for that exact origin and bounded streaming. */
export async function fetchOriginal(frame:Frame,context:BrowserContext,url:string,allowedOrigins:string[],signal:AbortSignal):Promise<Buffer> {
  if(url.startsWith('blob:') || url.startsWith('data:')) {
    if(url.length>MAX_ASSET*1.4)throw new WorkerError('MEDIA_TOO_LARGE',422);
    const base64=await frame.evaluate(async ({url,limit})=>{
      const response=await fetch(url,{signal:AbortSignal.timeout(15_000)});
      if(!response.ok || !response.body)throw new Error('MEDIA_UNAVAILABLE');
      const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
      try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit)throw new Error('MEDIA_TOO_LARGE');chunks.push(part.value);}}
      finally{await reader.cancel();}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      return btoa(binary);
    },{url,limit:MAX_ASSET}).catch(()=>{throw new WorkerError('MEDIA_UNAVAILABLE',422);});
    signal.throwIfAborted();return Buffer.from(base64,'base64');
  }
  let current=new URL(url,frame.url());
  for(let redirects=0;redirects<=3;redirects++){
    if(!allowedOrigins.includes(current.origin)||current.username||current.password||!['http:','https:'].includes(current.protocol))throw new WorkerError('MEDIA_ORIGIN_NOT_ALLOWED',422);
    const cookies=await context.cookies(current.href);
    const cookie=cookies.map(c=>`${c.name}=${c.value}`).join('; ');
    let response:Response;
    try{response=await fetch(current,{headers:cookie?{Cookie:cookie}:{},redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(15_000)]),cache:'no-store'});}catch{throw new WorkerError('MEDIA_UNAVAILABLE',422);}
    if([301,302,303,307,308].includes(response.status)){
      await response.body?.cancel();const location=response.headers.get('location');if(!location)throw new WorkerError('MEDIA_UNAVAILABLE',422);current=new URL(location,current);continue;
    }
    if(!response.ok||!response.body)throw new WorkerError('MEDIA_UNAVAILABLE',422);
    const length=Number(response.headers.get('content-length')??0);
    if(length>MAX_ASSET){await response.body.cancel();throw new WorkerError('MEDIA_TOO_LARGE',422);}
    const reader=response.body.getReader();let total=0;const chunks:Buffer[]=[];
    try{while(true){const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>MAX_ASSET)throw new WorkerError('MEDIA_TOO_LARGE',422);chunks.push(Buffer.from(part.value));}}
    finally{await reader.cancel();}
    return Buffer.concat(chunks,total);
  }
  throw new WorkerError('MEDIA_REDIRECT_LIMIT',422);
}
