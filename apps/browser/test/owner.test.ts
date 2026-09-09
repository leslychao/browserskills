import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type BrowserContext } from 'playwright';
import { BrowserOwner } from '../src/owner.js';

afterEach(()=>vi.restoreAllMocks());

it('waits for a cancelled pending launch to close its profile before shutdown resolves',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'browserskills-launch-'));
  let launchStarted!:()=>void;let finishLaunch!:(context:BrowserContext)=>void;
  const started=new Promise<void>(resolve=>{launchStarted=resolve;});
  const launch=new Promise<BrowserContext>(resolve=>{finishLaunch=resolve;});
  vi.spyOn(chromium,'launchPersistentContext').mockImplementation(()=>{launchStarted();return launch;});
  let releaseContextClose!:()=>void;
  const contextClosed=new Promise<void>(resolve=>{releaseContextClose=resolve;});
  const contextClose=vi.fn(()=>contextClosed);
  const owner=new BrowserOwner({workerId:'browser-1',profileDir:join(directory,'profile'),mediaDir:join(directory,'media'),headless:true});
  const opening=owner.command({id:randomUUID(),type:'OPEN'});
  const openingResult=opening.catch(error=>error);
  await started;
  let shutdownComplete=false;
  const closing=owner.close().then(()=>{shutdownComplete=true;});
  try{
    await new Promise(resolve=>setImmediate(resolve));expect(shutdownComplete).toBe(false);
    finishLaunch({close:contextClose} as unknown as BrowserContext);
    await new Promise(resolve=>setImmediate(resolve));expect(contextClose).toHaveBeenCalledTimes(1);expect(shutdownComplete).toBe(false);
    releaseContextClose();await closing;
    expect(await openingResult).toMatchObject({code:'STOPPED'});expect(owner.status().mode).toBe('CLOSED');
  }finally{finishLaunch({close:contextClose} as unknown as BrowserContext);releaseContextClose();await openingResult;await closing;await rm(directory,{recursive:true,force:true});}
});
