import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile,readFile,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { MediaStore, parseRange, fetchOriginal } from '../src/media.js';
import { wave, startTestSite } from '../../../tests/test-site/server.js';

const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function store(){const path=await mkdtemp(join(tmpdir(),'browserskills-media-'));cleanup.push(()=>rm(path,{recursive:true,force:true}));return new MediaStore(path);}

describe('bounded original media',()=>{
  it.each([['bytes=0-4',{start:0,end:4}],['bytes=4-',{start:4,end:9}],['bytes=-3',{start:7,end:9}],['bytes=0-100',{start:0,end:9}]] as const)('supports single range %s',(input,expected)=>expect(parseRange(input,10)).toEqual(expected));
  it.each(['bytes=10-11','bytes=5-2','bytes=-0','bytes=0-1,3-4','bytes=-','invalid'])('rejects invalid range %s',input=>expect(()=>parseRange(input,10)).toThrow());
  it('returns full response when no Range is requested',()=>expect(parseRange(undefined,10)).toBeNull());
  it('keeps original audio bytes and verifies real decoder duration',async()=>{
    const media=await store();const original=wave();const asset=await media.put(original,'audio');
    expect(asset.mimeType).toBe('audio/wav');expect(asset.durationMs).toBe(100);expect(asset.sha256).toBe(createHash('sha256').update(original).digest('hex'));
    expect(await media.read(asset.id)).toEqual(original);expect(await media.put(original,'audio')).toEqual(asset);
    await media.clear();expect(()=>media.metadata(asset.id)).toThrow();await expect(media.read(asset.id)).rejects.toThrow();
  });
  it('rejects broken and oversized audio without clipping it',async()=>{
    const media=await store();await expect(media.put(Buffer.from('not audio'),'audio')).rejects.toHaveProperty('code');
    await expect(media.put(wave(61),'audio')).rejects.toMatchObject({code:'AUDIO_TOO_LONG'});
    await expect(media.put(Buffer.alloc(20*1024*1024+1),'audio')).rejects.toMatchObject({code:'MEDIA_TOO_LARGE'});
    await expect(media.put(Buffer.from('#EXTM3U\nhttp://127.0.0.1/private'),'audio')).rejects.toMatchObject({code:'UNSUPPORTED_AUDIO'});
    await expect(media.put(Buffer.from('ffconcat version 1.0\nfile /run/secrets/worker_token'),'audio')).rejects.toMatchObject({code:'UNSUPPORTED_AUDIO'});
  });
  it('allows bounded longer instruction audio but still enforces the task clip limit on a cached asset',async()=>{
    const media=await store();const original=wave(61);expect((await media.put(original,'audio',120_000)).durationMs).toBe(61_000);
    await expect(media.put(original,'audio',60_000)).rejects.toMatchObject({code:'AUDIO_TOO_LONG'});
    const threeChannels=wave();threeChannels.writeUInt16LE(3,22);threeChannels.writeUInt16LE(6,32);threeChannels.writeUInt32LE(96000,28);
    await expect(media.put(threeChannels,'audio')).rejects.toMatchObject({code:'UNSUPPORTED_AUDIO'});
  });
  it.each([['mp3','audio/mpeg'],['flac','audio/flac'],['ogg','audio/ogg'],['webm','audio/webm'],['mp4','audio/mp4']] as const)('validates original %s audio using real ffmpeg and ffprobe',async(format,mime)=>{
    const media=await store();const output=spawnSync(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-i','pipe:0',...(format==='mp4'?['-movflags','frag_keyframe+empty_moov']:[]),'-f',format,'pipe:1'],{input:wave(),maxBuffer:2*1024*1024,timeout:10_000,windowsHide:true});
    expect(output.status).toBe(0);const asset=await media.put(output.stdout,'audio');expect(asset.mimeType).toBe(mime);expect(await media.read(asset.id)).toEqual(output.stdout);
  });
  it('rejects a missing decoder explicitly and rejects unsupported image shapes/types',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'browserskills-probe-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
    await expect(new MediaStore(directory,join(directory,'missing-ffprobe')).put(wave(),'audio')).rejects.toMatchObject({code:'MEDIA_PROBE_UNAVAILABLE'});
    const media=await store();await expect(media.put(Buffer.from('bad'),'image')).rejects.toMatchObject({code:'UNSUPPORTED_IMAGE'});
    await expect(media.put(Buffer.alloc(0),'image')).rejects.toMatchObject({code:'MEDIA_TOO_LARGE'});
    const wide=await sharp({create:{width:9000,height:1,channels:3,background:'red'}}).png().toBuffer();await expect(media.put(wide,'image')).rejects.toMatchObject({code:'UNSUPPORTED_IMAGE'});
    const tiff=await sharp({create:{width:1,height:1,channels:3,background:'red'}}).tiff().toBuffer();await expect(media.put(tiff,'image')).rejects.toMatchObject({code:'UNSUPPORTED_IMAGE'});
  });
  it('retains only the active task media IDs and cancels late media commits after stop',async()=>{
    const media=await store();const first=await media.put(wave(.1),'audio');const second=await media.put(wave(.2),'audio');
    await media.retain(new Set([first.id]));expect(()=>media.metadata(second.id)).toThrow();expect(media.metadata(first.id)).toEqual(first);
    const pending=media.put(wave(.3),'audio');await media.clear();await expect(pending).rejects.toMatchObject({code:'STOPPED'});
  });
  it('stores more than the former 64 MiB limit on disk and removes stale owned files at startup',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'yang-media-budget-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));const media=new MediaStore(directory);
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=','base64');const assets=[];
    for(let i=0;i<5;i++){const bytes=Buffer.alloc(14*1024*1024);png.copy(bytes);bytes[bytes.length-1]=i;assets.push(await media.put(bytes,'image'));}
    expect(assets.reduce((sum,a)=>sum+a.byteLength,0)).toBeGreaterThan(64*1024*1024);expect((await readdir(directory)).length).toBe(5);
    await writeFile(join(directory,'unrelated-marker'),'keep');await new MediaStore(directory).initialize();expect(await readdir(directory)).toEqual(['unrelated-marker']);expect(await readFile(join(directory,'unrelated-marker'),'utf8')).toBe('keep');
  });
  it('checks every redirect and enforces declared/streamed byte bounds with real HTTP',async()=>{
    const site=await startTestSite();cleanup.push(site.close);const browser=await chromium.launch({headless:true,chromiumSandbox:true});cleanup.push(()=>browser.close());
    const context=await browser.newContext();const page=await context.newPage();await page.goto(site.url);const get=(path:string)=>fetchOriginal(page.mainFrame(),context,site.url+path,[site.url],new AbortController().signal);
    expect((await get('/redirect')).subarray(0,4)).toEqual(Buffer.from([137,80,78,71]));
    for(const [path,code] of [['/cross-redirect','MEDIA_ORIGIN_NOT_ALLOWED'],['/redirect-loop','MEDIA_REDIRECT_LIMIT'],['/bad-redirect','MEDIA_UNAVAILABLE'],['/unavailable','MEDIA_UNAVAILABLE'],['/oversized','MEDIA_TOO_LARGE'],['/chunked-huge','MEDIA_TOO_LARGE']])await expect(get(path!)).rejects.toMatchObject({code});
    const data='data:audio/wav;base64,'+wave().toString('base64');expect(await fetchOriginal(page.mainFrame(),context,data,[site.url],new AbortController().signal)).toEqual(wave());
    const aborted=new AbortController();aborted.abort();await expect(fetchOriginal(page.mainFrame(),context,site.url+'/audio.wav',[site.url],aborted.signal)).rejects.toHaveProperty('code');
  });
});
