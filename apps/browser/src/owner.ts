import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chromium, type BrowserContext } from 'playwright';
import type { BrowserStatus, WorkerCommand } from '@browserskills/contracts';
import { YangAdapter, YANDEX_START_URL, type AdapterOptions } from './adapter.js';
import { MediaStore, sha256 } from './media.js';
import { WorkerError } from './errors.js';

export interface OwnerOptions {
  workerId:string;profileDir:string;mediaDir:string;
  headless?:boolean;executablePath?:string;
  /** Constructor-only test injection; production main never reads these from requests or environment. */
  startUrl?:string;adapterOptions?:AdapterOptions;verificationTimeoutMs?:number;
}

export class BrowserOwner extends EventEmitter {
  readonly media:MediaStore;
  private context:BrowserContext|null=null;
  private opening:Promise<BrowserContext>|null=null;
  private adapter:YangAdapter|null=null;
  private yang:BrowserStatus['yang']={state:'UNKNOWN',checkedAt:new Date().toISOString(),message:null,poolId:null,suiteId:null};
  private generation=randomUUID();
  private mode:BrowserStatus['mode']='CLOSED';
  private runId:string|null=null;
  private epoch=0;
  private tail:Promise<unknown>=Promise.resolve();
  private readonly commands=new Map<string,{hash:string;type:WorkerCommand['type'];result:Promise<unknown>|null}>();
  private manualTimer:NodeJS.Timeout|null=null;
  constructor(private readonly options:OwnerOptions){super();this.media=new MediaStore(options.mediaDir);}

  status():BrowserStatus{return {workerId:this.options.workerId,generation:this.generation,mode:this.mode,url:this.context?.pages()[0]?.url()??null,runId:this.runId,yang:this.yang};}
  async refreshedStatus():Promise<BrowserStatus>{if(this.adapter)this.yang=await this.adapter.session().catch(()=>({...this.yang,state:'UNKNOWN' as const,checkedAt:new Date().toISOString()}));return this.status();}
  isManual(generation?:string):boolean{return this.mode==='MANUAL'&&(!generation||this.generation===generation);}
  private revoke():void {if(this.manualTimer)clearTimeout(this.manualTimer);this.manualTimer=null;this.emit('revoke');}
  private ensureGeneration(command:WorkerCommand):void {if(command.generation!==this.generation)throw new WorkerError('STALE_GENERATION');}
  private ensureRun(command:WorkerCommand):void {this.ensureGeneration(command);if(this.mode!=='AUTOMATION'||!command.runId||this.runId!==command.runId)throw new WorkerError('STALE_RUN');}

  command(command:WorkerCommand):Promise<unknown>{
    const hash=sha256(JSON.stringify(command));const existing=this.commands.get(command.id);
    if(existing){if(existing.hash!==hash)return Promise.reject(new WorkerError('IDEMPOTENCY_CONFLICT'));return existing.result??Promise.reject(new WorkerError('COMMAND_EXPIRED'));}
    if(this.commands.size>=512){const first=this.commands.keys().next().value;if(first)this.commands.delete(first);}
    const epoch=this.epoch;
    // STOP/CLOSE bypass the queue to cancel a click that is still waiting for actionability.
    let result:Promise<unknown>;
    if(command.type==='STOP'||command.type==='CLOSE'){
      result=(async()=>{if(command.type==='STOP')this.ensureRun(command);await this.close();return this.status();})();
    }else{
      result=this.tail.catch(()=>undefined).then(()=>{if(epoch!==this.epoch)throw new WorkerError('STALE_GENERATION');return this.execute(command);});
      this.tail=result;
    }
    this.commands.set(command.id,{hash,type:command.type,result});return result;
  }
  private expireSnapshots(exceptId?:string):void {
    // Keep the idempotency tombstone, not instructions from completed/invalidated tasks.
    for(const [id,entry] of this.commands)if(['SNAPSHOT','APPLY','MAP_FIELDS','INSTRUCTION'].includes(entry.type)&&id!==exceptId)entry.result=null;
  }
  private async execute(command:WorkerCommand):Promise<unknown>{
    switch(command.type){
      case 'OPEN':
        if(this.context)return this.status();
        await this.media.initialize();
        const openingEpoch=this.epoch;
        const opening=this.opening=chromium.launchPersistentContext(this.options.profileDir,{headless:this.options.headless??false,
          // main owns these signals. A second Playwright close would force-kill the profile mid-flush.
          handleSIGTERM:false,handleSIGINT:false,
          ...(this.options.executablePath?{executablePath:this.options.executablePath}:{}),chromiumSandbox:true,
          acceptDownloads:false,viewport:{width:1366,height:768},ignoreHTTPSErrors:false,args:['--disable-sync','--disable-background-networking']}).then(async openedContext=>{
          // Closing must wait for this cleanup even if the context did not exist when it began.
          if(openingEpoch!==this.epoch){await openedContext.close();throw new WorkerError('STOPPED');}
          this.context=openedContext;return openedContext;
        });
        let openedContext:BrowserContext;
        try{openedContext=await opening;}finally{if(this.opening===opening)this.opening=null;}
        if(openingEpoch!==this.epoch)throw new WorkerError('STOPPED');
        openedContext.setDefaultTimeout(5_000);openedContext.setDefaultNavigationTimeout(30_000);
        const page=openedContext.pages()[0]??await openedContext.newPage();
        for(const extra of openedContext.pages().slice(1))await extra.close();
        if(openingEpoch!==this.epoch)throw new WorkerError('STOPPED');
        // Adapter-owned instruction/catalogue pages have no opener; unsolicited page popups are closed.
        openedContext.on('page',extra=>{if(extra!==page)void extra.opener().then(opener=>{if(opener)return extra.close();}).catch(()=>undefined);});
        openedContext.on('close',()=>{if(this.context!==openedContext)return;this.epoch++;this.generation=randomUUID();this.revoke();this.context=null;this.adapter?.cancel();this.adapter=null;this.mode='CLOSED';this.runId=null;this.expireSnapshots();this.tail=Promise.resolve();void this.media.clear();});
        page.on('dialog',dialog=>void dialog.dismiss().catch(()=>undefined));
        page.on('download',download=>void download.cancel().catch(()=>undefined));
        this.adapter=new YangAdapter(page,this.media,{...this.options.adapterOptions,verificationTimeoutMs:this.options.verificationTimeoutMs});
        this.mode='IDLE';
        await page.goto(this.options.startUrl??YANDEX_START_URL,{waitUntil:'domcontentloaded'});
        return this.status();
      case 'ENTER_MANUAL':
        if(!this.context||this.mode==='CLOSED')throw new WorkerError('BROWSER_CLOSED');
        if(this.mode==='AUTOMATION')throw new WorkerError('BROWSER_BUSY');
        if(command.generation)this.ensureGeneration(command);
        this.revoke();this.mode='MANUAL';
        this.manualTimer=setTimeout(()=>{this.revoke();if(this.mode==='MANUAL')this.mode='IDLE';},60*60*1000);
        this.manualTimer.unref();return this.status();
      case 'EXIT_MANUAL':
        if(command.generation)this.ensureGeneration(command);
        this.revoke();if(this.mode==='MANUAL')this.mode='IDLE';return this.status();
      case 'BEGIN':
        this.ensureGeneration(command);
        if(!this.context||!this.adapter)throw new WorkerError('BROWSER_CLOSED');
        if(this.mode==='AUTOMATION')throw new WorkerError('BROWSER_BUSY');
        if(!command.runId)throw new WorkerError('INVALID_COMMAND',400);
        this.revoke();this.mode='AUTOMATION';this.runId=command.runId;return this.status();
      case 'SNAPSHOT':this.ensureRun(command);this.expireSnapshots(command.id);return this.adapter!.snapshot();
      case 'YANG_SESSION':
        if(!this.adapter)throw new WorkerError('BROWSER_CLOSED');this.yang=await this.adapter.session();return this.yang;
      case 'CATALOGUE':
        if(!this.adapter)throw new WorkerError('BROWSER_CLOSED');return this.adapter.catalogue(command.payload.refresh);
      case 'INSTRUCTION':this.ensureRun(command);this.expireSnapshots(command.id);return this.adapter!.instruction(command.payload.poolId);
      case 'SELECT_PROJECT':this.ensureRun(command);this.yang=await this.adapter!.selectProject(command.payload.poolId);return this.status();
      case 'MAP_FIELDS':this.ensureRun(command);this.expireSnapshots(command.id);return this.adapter!.mapFields(command.payload);
      case 'APPLY':this.ensureRun(command);this.expireSnapshots(command.id);return this.adapter!.apply(command.payload);
      case 'SUBMIT':this.ensureRun(command);this.expireSnapshots();return this.adapter!.submit(command.payload);
      case 'PAUSE':this.ensureRun(command);this.revoke();this.mode='IDLE';this.runId=null;return this.refreshedStatus();
      default:throw new WorkerError('INVALID_COMMAND',400);
    }
  }
  async close():Promise<void>{
    this.epoch++;this.revoke();this.mode='CLOSED';this.runId=null;this.generation=randomUUID();
    this.expireSnapshots();
    this.adapter?.cancel();this.adapter=null;const context=this.context;this.context=null;const opening=this.opening;
    const closing=(async()=>{await context?.close({reason:'Stopped by owner'}).catch(()=>undefined);await opening?.catch(()=>undefined);await this.media.clear();})();
    this.tail=closing;await closing;
  }
}
