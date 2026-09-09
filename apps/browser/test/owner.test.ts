import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type BrowserContext } from 'playwright';
import { BrowserOwner } from '../src/owner.js';

afterEach(()=>vi.restoreAllMocks());

it('opens the confirmed Yang catalogue by default without a test URL override',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'browserskills-yang-'));
  let currentUrl='about:blank';
  const page={on:vi.fn(),goto:vi.fn(async(url:string)=>{currentUrl=url;}),url:()=>currentUrl,isClosed:()=>false,evaluate:vi.fn(async()=> 'UNKNOWN')};
  const context={pages:()=>[page],on:vi.fn(),setDefaultTimeout:vi.fn(),setDefaultNavigationTimeout:vi.fn(),close:vi.fn(async()=>{})};
  vi.spyOn(chromium,'launchPersistentContext').mockResolvedValue(context as unknown as BrowserContext);
  const owner=new BrowserOwner({workerId:'browser-1',profileDir:join(directory,'profile'),mediaDir:join(directory,'media')});
  try{
    await owner.command({id:randomUUID(),type:'OPEN'});
    expect(page.goto).toHaveBeenCalledExactlyOnceWith('https://yang.yandex-team.ru/?activeTab=all',{waitUntil:'domcontentloaded'});
    expect(owner.status()).toMatchObject({mode:'IDLE',url:'https://yang.yandex-team.ru/?activeTab=all'});
    const runId=randomUUID();const generation=owner.status().generation!;
    await owner.command({id:randomUUID(),type:'BEGIN',generation,runId});
    await expect(owner.command({id:randomUUID(),type:'SNAPSHOT',generation,runId})).rejects.toMatchObject({code:'YANG_LOGIN_REQUIRED'});
    // The previous Tasks target must not remain an accepted production origin.
    currentUrl='https://tasks.yandex.ru/user';
    await expect(owner.command({id:randomUUID(),type:'SNAPSHOT',generation,runId})).rejects.toMatchObject({code:'YANG_LOGIN_REQUIRED'});
  }finally{await owner.close();await rm(directory,{recursive:true,force:true});}
});

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
