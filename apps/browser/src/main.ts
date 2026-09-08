import { readFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BrowserOwner } from './owner.js';
import { createWorkerServer } from './server.js';

const token=(await readFile(process.env.WORKER_TOKEN_FILE??'/run/secrets/worker_token','utf8')).trim();
const workerId=process.env.WORKER_ID??'';if(!/^browser-[1-5]$/.test(workerId))throw new Error('Invalid WORKER_ID');
const mediaDir=resolve(process.env.MEDIA_DIR??'/run/browser/media');await mkdir(mediaDir,{recursive:true,mode:0o700});
// Restart never retains another generation's active material. Only our opaque asset names are removed.
for(const entry of await readdir(mediaDir,{withFileTypes:true}))if(entry.isFile()&&/^[a-f0-9-]{36}$/.test(entry.name))await unlink(join(mediaDir,entry.name));
const owner=new BrowserOwner({workerId,profileDir:process.env.PROFILE_DIR??'/data/profile',mediaDir});
const application=createWorkerServer(owner,token,Number(process.env.RFB_PORT??5900));
application.server.listen(Number(process.env.PORT??3000),'0.0.0.0');
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void application.close().then(()=>process.exit(0));});
