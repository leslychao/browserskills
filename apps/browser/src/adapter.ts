import type { ElementHandle,Frame,Page,JSHandle } from 'playwright';
import type { Catalogue,FieldAnswer,FieldGrouping,InstructionBlock,InstructionBundle,SubmitPayload,SubmitResult,TaskField,TaskSet,YangSession } from '@browserskills/contracts';
import { validateAnswers,TaskSetSchema } from '@browserskills/contracts';
import { MediaStore,fetchOriginal,sha256 } from './media.js';
import { WorkerError } from './errors.js';
import { authDom,catalogueDom,instructionDom,partDom,type RawPart,type RawMedia } from './yang-dom.js';

export const YANDEX_ORIGIN='https://yang.yandex-team.ru';
export const YANDEX_START_URL=`${YANDEX_ORIGIN}/?activeTab=all`;
const CONTROL_SELECTOR='input:not([type="hidden"]):not([type="submit"]):not([type="button"]),textarea,select,button[aria-pressed],[role="radio"],[role="checkbox"]';
export interface AdapterOptions { /** Constructor-only fixtures; never read from requests or environment. */ origin?:string;frameOrigin?:string;mediaOrigins?:string[];instructionOrigins?:string[];verificationTimeoutMs?:number; }
export interface FieldMapping {suiteId:string;snapshotHash:string;groups:FieldGrouping[];}
interface Captured {raw:RawPart;root:ElementHandle<Node>;frame:Frame;pageIndex:number;formIndex:number;}
interface Lease {snapshot:TaskSet;raw:RawPart[];pagination:number;consumed:boolean;}

/** Yang owns navigation and submission; model output only names captured form controls. */
export class YangAdapter {
  private readonly origin:string;private readonly frameOrigin:string;private readonly mediaOrigins:string[];private readonly instructionOrigins:string[];
  private readonly abort=new AbortController();private lease:Lease|null=null;private readySeen=false;
  private mappings:FieldGrouping[]=[];private mappingSuite:string|null=null;private readonly attempted=new Set<string>();
  private instructionAssets=new Set<string>();
  private deadline:{suiteId:string;at:number}|null=null;
  private readonly documentStatus=new WeakMap<Frame,number>();
  constructor(private readonly page:Page,private readonly media:MediaStore,private readonly options:AdapterOptions={}){
    this.origin=options.origin??YANDEX_ORIGIN;this.frameOrigin=options.frameOrigin??'https://iframe-yang.yandex';
    this.mediaOrigins=options.mediaOrigins??['https://storage.mds.yandex.net'];this.instructionOrigins=options.instructionOrigins??[YANDEX_ORIGIN,'https://jing.yandex-team.ru'];
  }
  cancel():void {this.abort.abort();this.lease=null;}
  private check():void {if(this.abort.signal.aborted||this.page.isClosed())throw new WorkerError('STOPPED');}
  private identity():{poolId:string;suiteId:string}|null {const url=new URL(this.page.url());if(url.origin!==this.origin)return null;const match=/^\/task\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);return match?{poolId:decodeURIComponent(match[1]!),suiteId:decodeURIComponent(match[2]!)}:null;}
  async session():Promise<YangSession>{
    this.check();let state:YangSession['state']='UNKNOWN';const origin=new URL(this.page.url()).origin;
    if(origin===this.origin||origin==='https://passport.yandex-team.ru'){
      const dom=await this.page.evaluate(authDom);state=dom==='CONNECTED'?'READY':dom==='SECOND_FACTOR_REQUIRED'?'TWO_FACTOR_REQUIRED':dom;
      if(state==='READY')this.readySeen=true;else if(state==='LOGIN_REQUIRED'&&this.readySeen)state='AUTH_EXPIRED';
    }
    return {state,checkedAt:new Date().toISOString(),message:null,poolId:this.identity()?.poolId??null,suiteId:this.identity()?.suiteId??null};
  }
  private async authenticated():Promise<void>{const session=await this.session();if(session.state!=='READY')throw new WorkerError(session.state==='TWO_FACTOR_REQUIRED'?'TWO_FACTOR_REQUIRED':session.state==='AUTH_EXPIRED'?'AUTH_EXPIRED':'YANG_LOGIN_REQUIRED');}
  private async auxiliary<T>(url:string,work:(page:Page)=>Promise<T>):Promise<T>{
    this.check();const page=await this.page.context().newPage();page.on('response',response=>{const request=response.request();if(request.isNavigationRequest()&&request.resourceType()==='document')try{this.documentStatus.set(request.frame(),response.status());}catch{}});try{page.setDefaultTimeout(5000);const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30_000});if(!response?.ok())throw new WorkerError('SOURCE_UNAVAILABLE');this.check();return await work(page);}finally{await page.close().catch(()=>undefined);}
  }
  private cards(page:Page){return page.locator('li').filter({has:page.locator('h1,h2,h3,h4,h5,h6')}).filter({has:page.getByRole('button',{name:'Инструкция',exact:true})});}
  private async catalogueRows(page:Page){
    const rows=await page.evaluate(catalogueDom);const cards=this.cards(page);
    for(const row of rows){if(row.poolId)continue;const card=cards.nth(row.cardIndex);if((await card.locator('h1,h2,h3,h4,h5,h6').innerText()).trim()!==row.title)throw new WorkerError('CATALOGUE_CHANGED');
      await card.getByRole('button',{name:'Инструкция',exact:true}).click();const dialog=page.getByRole('dialog');
      try{const link=dialog.getByRole('link',{name:'Открыть в новой вкладке',exact:true});const href=await link.getAttribute('href');const url=href?new URL(href,this.origin):null;const match=url?.origin===this.origin?url.pathname.match(/^\/instructions\/([^/]+)\/?$/):null;if(!match)throw new WorkerError('CATALOGUE_ID_UNAVAILABLE');row.poolId=decodeURIComponent(match[1]!);}
      finally{await dialog.getByRole('button',{name:'Закрыть',exact:true}).filter({visible:true}).last().click();}
    }
    if(new Set(rows.map(row=>row.poolId)).size!==rows.length)throw new WorkerError('AMBIGUOUS_CATALOGUE');return rows;
  }
  async catalogue(refresh=false):Promise<Catalogue>{
    await this.authenticated();const active=this.identity();
    const read=async(page:Page)=>{if(new URL(page.url()).origin!==this.origin)throw new WorkerError('AUTH_EXPIRED');return this.catalogueRows(page);};
    // Always isolate discovery from manual navigation and reserved suites.
    const all=await this.auxiliary(`${this.origin}/?activeTab=all`,read);const ongoing=await this.auxiliary(`${this.origin}/?activeTab=active`,read);const rows=[...new Map([...all,...ongoing].map(row=>[row.poolId,row])).values()];const activePools=new Set(ongoing.map(row=>row.poolId));
    const items:Catalogue['items']=rows.map(row=>({poolId:row.poolId,title:row.title,reward:row.price&&row.unit?{amount:row.price,unit:row.unit}:null,availability:row.poolId===active?.poolId||activePools.has(row.poolId)?'ACTIVE':row.available?'AVAILABLE':'UNAVAILABLE',kind:row.exam?'EXAM':row.training?'TRAINING':'WORK',modalities:row.modalities,preparation:'UNPREPARED',reason:null}));
    return {items,refreshedAt:new Date().toISOString(),activePoolId:active?.poolId??(ongoing.length===1?ongoing[0]!.poolId:null),activeSuiteId:active?.suiteId??null};
  }
  async selectProject(poolId:string):Promise<YangSession>{
    await this.authenticated();const active=this.identity();if(active){if(active.poolId!==poolId)throw new WorkerError('ACTIVE_SUITE_EXISTS');return this.session();}
    const ongoing=await this.auxiliary(`${this.origin}/?activeTab=active`,page=>this.catalogueRows(page));if(ongoing.length&&!ongoing.some(row=>row.poolId===poolId))throw new WorkerError('ACTIVE_SUITE_EXISTS');
    await this.page.goto(`${this.origin}/?activeTab=${ongoing.length?'active':'all'}`,{waitUntil:'domcontentloaded'});const rows=await this.catalogueRows(this.page);const chosen=rows.find(c=>c.poolId===poolId);if(!chosen?.available)throw new WorkerError('PROJECT_UNAVAILABLE');
    const card=this.cards(this.page).nth(chosen.cardIndex);if((await card.locator('h1,h2,h3,h4,h5,h6').innerText()).trim()!==chosen.title)throw new WorkerError('CATALOGUE_CHANGED');
    await card.getByRole('button',{name:/^(Приступить|Продолжить)$/}).click();
    await this.page.waitForURL(url=>url.origin===this.origin&&url.pathname.startsWith(`/task/${encodeURIComponent(poolId)}/`),{timeout:10_000}).catch(()=>{throw new WorkerError('RESERVATION_UNCONFIRMED');});
    return this.session();
  }
  async instruction(poolId:string):Promise<InstructionBundle>{
    this.check();const source=`${this.origin}/instructions/${encodeURIComponent(poolId)}`;const blocks:InstructionBlock[]=[];const visited=new Set<string>();
    const read=async(url:string):Promise<void>=>{
      if(visited.has(url))return;if(visited.size>=16)throw new WorkerError('INSTRUCTIONS_TOO_LARGE');
      const target=new URL(url);if(!this.instructionOrigins.includes(target.origin)||target.username||target.password||/\.pdf$/i.test(target.pathname))throw new WorkerError('INSTRUCTIONS_SOURCE_UNSUPPORTED');visited.add(url);
      await this.auxiliary(url,async page=>{
        if(!this.instructionOrigins.includes(new URL(page.url()).origin))throw new WorkerError('INSTRUCTION_UNAVAILABLE');
        if(target.origin===this.origin&&target.pathname.startsWith('/instructions/'))await page.locator('iframe').waitFor({state:'attached',timeout:10_000});
        const frames=page.frames().filter(frame=>frame!==page.mainFrame());if(frames.length>1)throw new WorkerError('INSTRUCTIONS_UNSUPPORTED');const frame=frames[0]??page.mainFrame();
        await frame.waitForLoadState('domcontentloaded');await frame.waitForFunction(()=>!!document.body&&(document.body.textContent??'').trim().length>0,{},{timeout:10_000});
        const frameUrl=frame.url();const status=this.documentStatus.get(frame);if(/^https?:/.test(frameUrl)&&(!status||status<200||status>=300))throw new WorkerError('SOURCE_UNAVAILABLE');
        if(frameUrl!=='about:blank'&&frameUrl!=='about:srcdoc'&&!this.instructionOrigins.includes(new URL(frameUrl).origin))throw new WorkerError('INSTRUCTIONS_SOURCE_UNSUPPORTED');
        const auth=await frame.evaluate(authDom);if(auth==='LOGIN_REQUIRED'||auth==='SECOND_FACTOR_REQUIRED')throw new WorkerError('INSTRUCTIONS_AUTH_REQUIRED');const raw=await frame.evaluate(instructionDom);
        for(const block of raw.blocks){this.check();const id=`block-${blocks.length+1}`;if(block.type==='text')blocks.push({id,type:'text',text:block.text});else{const bytes=await fetchOriginal(frame,this.page.context(),block.url,this.mediaOrigins,this.abort.signal);const asset=await this.media.put(bytes,block.type,120_000);blocks.push({id,type:block.type,asset,...(block.caption?{caption:block.caption}:{})});}}
        for(const document of raw.documents)await read(document);
      });
    };
    try{await read(source);}catch(error){if(error instanceof WorkerError)throw error;throw new WorkerError('INSTRUCTION_UNAVAILABLE');}
    if(!blocks.length)throw new WorkerError('INSTRUCTION_INCOMPLETE');const semantic=blocks.map(block=>block.type==='text'?block:{...block,asset:{...block.asset,id:undefined}});
    this.instructionAssets=new Set(blocks.flatMap(block=>block.type==='text'?[]:[block.asset.id]));return {sourceKey:`yang:${poolId}`,hash:sha256(JSON.stringify({sources:[...visited],blocks:semantic})),blocks};
  }
  private async frame():Promise<Frame>{
    if(new URL(this.page.url()).origin!==this.origin)throw new WorkerError('UNSUPPORTED_ORIGIN');
    const frames=this.page.frames().filter(frame=>frame!==this.page.mainFrame()&&(()=>{try{return new URL(frame.url()).origin===this.frameOrigin;}catch{return false;}})());
    if(frames.length!==1)throw new WorkerError('UNSUPPORTED_TASK_FRAME');return frames[0]!;
  }
  private async pageCount(frame:Frame):Promise<number>{
    const numbers=await frame.locator('button:not([aria-pressed]):not([role="radio"])').evaluateAll(elements=>elements.filter(e=>!e.closest('[hidden],[aria-hidden="true"]')&&/^\d+$/.test(e.textContent?.trim()??'')).map(e=>Number(e.textContent?.trim())));
    if(!numbers.length)return 1;if(numbers.length>50||numbers.some((n,i)=>n!==i+1))throw new WorkerError('AMBIGUOUS_PAGINATION');return numbers.length;
  }
  private async navigatePart(frame:Frame,index:number,count:number,keyboard=false):Promise<void>{if(count<=1)return;const target=frame.getByRole('button',{name:String(index+1),exact:true});if(keyboard){await target.evaluate(e=>(e as HTMLElement).focus({preventScroll:true}));await this.page.keyboard.press('Enter');}else await target.click();this.check();}
  private async capture(count?:number,keyboard=false,deadline=Infinity):Promise<{parts:Captured[];pagination:number}>{
    const frame=await this.frame();const pagination=count??await this.pageCount(frame);const parts:Captured[]=[];
    for(let pageIndex=0;pageIndex<pagination;pageIndex++){
      if(Date.now()>deadline)throw new WorkerError('SUBMIT_VALIDATION_TIMEOUT');await this.navigatePart(frame,pageIndex,pagination,keyboard);const roots=await frame.locator('form').elementHandles();if(!roots.length||roots.length>50||pagination>1&&roots.length!==1)throw new WorkerError('UNSUPPORTED_TASK');
      for(let formIndex=0;formIndex<roots.length;formIndex++){const root=roots[formIndex]!;const raw=await root.evaluate(partDom,`part-${parts.length+1}`);parts.push({raw,root,frame,pageIndex,formIndex});}
    }
    if(parts.length>50)throw new WorkerError('UNSUPPORTED_TASK');if(pagination>1&&new Set(parts.map(part=>part.raw.fingerprint.replace(/part-\d+/g,'part'))).size!==parts.length)throw new WorkerError('INCOMPLETE_TASK_SET');return {parts,pagination};
  }
  private stage(poolId:string,label:string):number{
    if(poolId==='94752008')return /Итог|Насколько сильно похожи/i.test(label)?1:0;
    if(poolId==='94707463'){if(/общее|в целом|общий|предпочт/i.test(label))return 0;if(/сравн|лучше|одинаков/i.test(label)&&!/качеств|скорост|приятност|естественност|ошибк|интонаци/i.test(label))return 2;return 1;}return 0;
  }
  private fields(raw:RawPart,poolId:string):TaskField[]{
    const fields:TaskField[]=raw.fields.map(field=>{
      const controls=field.controlIds.map(id=>raw.controls.find(c=>c.id===id)!);let value:string|string[]|number|null;
      if(field.kind==='TEXT'||field.kind==='NUMBER')value=controls[0]!.value as string|number|null;else{const selected=controls.flatMap(c=>Array.isArray(c.value)?c.value:[]);if(field.kind==='SINGLE_CHOICE'&&selected.length>1)throw new WorkerError('AMBIGUOUS_SELECTION');value=field.kind==='MULTIPLE_CHOICE'?selected:selected[0]??null;}
      return {id:field.id,label:field.label,kind:field.kind==='MULTIPLE_CHOICE'?'MULTI_CHOICE':field.kind,required:field.required,options:field.options,value,stage:this.stage(poolId,field.label),maxLength:field.kind==='TEXT'?Math.min(controls[0]!.maxLength??4000,16384):null,min:field.min,max:field.max};
    });
    for(const mapping of this.mappings.filter(m=>m.partId===raw.id)){
      const controls=mapping.controlIds.map(id=>raw.controls.find(c=>c.id===id));if(controls.some(c=>!c)||controls.some(c=>!raw.ungrouped.includes(c!.id)))continue;
      const selected=controls.flatMap(c=>Array.isArray(c!.value)?c!.value:[]);if(mapping.kind==='SINGLE_CHOICE'&&selected.length>1)throw new WorkerError('AMBIGUOUS_SELECTION');fields.push({id:mapping.fieldId,label:mapping.label,kind:mapping.kind,required:true,options:controls.map(c=>({id:c!.id,label:c!.label})),value:mapping.kind==='MULTI_CHOICE'?selected:selected[0]??null,stage:this.stage(poolId,mapping.label),maxLength:null,min:null,max:null});
    }
    if(poolId==='94707463'){
      const position=(field:TaskField)=>{const ids=raw.fields.find(f=>f.id===field.id)?.controlIds??this.mappings.find(m=>m.partId===raw.id&&m.fieldId===field.id)?.controlIds??[];return Math.min(...ids.map(id=>raw.controls.find(c=>c.id===id)?.index??Infinity));};
      const choices=fields.filter(f=>f.kind==='SINGLE_CHOICE').sort((a,b)=>position(a)-position(b));
      // The observed Yang template starts with overall preference. Its answer labels are not ratings.
      for(const field of choices)field.stage=field===choices[0]?0:field.options.every(o=>/❌|⚠|💚|^(bad|acceptable|good|плохо|нормально|хорошо)$/i.test(o.label.trim()))?1:2;
    }
    return fields;
  }
  private async taskMedia(frame:Frame,raw:RawMedia[]):Promise<TaskSet['parts'][number]['media']>{const media=[];for(const item of raw){this.check();const bytes=await fetchOriginal(frame,this.page.context(),item.url,this.mediaOrigins,this.abort.signal);media.push(await this.media.put(bytes,item.kind));}return media;}
  private async expires(suiteId:string):Promise<string>{
    const timer=await this.page.locator('.task-info__values-time').allTextContents();let at:number;
    if(timer.length===1){const match=/^(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)$/.exec(timer[0]!.trim());if(!match)throw new WorkerError('TASK_TIMER_UNAVAILABLE');const seconds=Number(match[1]??0)*3600+Number(match[2])*60+Number(match[3]);at=Date.now()+seconds*1000;}
    else{const values=await this.page.locator('time[datetime]').evaluateAll(elements=>elements.map(e=>e.getAttribute('datetime')));if(values.length!==1||!values[0]||!Number.isFinite(Date.parse(values[0])))throw new WorkerError('TASK_TIMER_UNAVAILABLE');at=Date.parse(values[0]);}
    if(this.deadline?.suiteId===suiteId)at=Math.min(this.deadline.at,at);this.deadline={suiteId,at};if(at<=Date.now())throw new WorkerError('TASK_EXPIRED');return new Date(at).toISOString();
  }
  async snapshot():Promise<TaskSet>{
    await this.authenticated();const identity=this.identity();if(!identity)throw new WorkerError('NO_ACTIVE_SUITE');if(this.mappingSuite!==identity.suiteId){this.mappings=[];this.mappingSuite=identity.suiteId;}
    const expiresAt=await this.expires(identity.suiteId);const instruction=await this.instruction(identity.poolId);const captured=await this.capture();const parts:TaskSet['parts']=[];
    for(const part of captured.parts){const fields=this.fields(part.raw,identity.poolId);const mapped=new Set(this.mappings.filter(m=>m.partId===part.raw.id&&fields.some(f=>f.id===m.fieldId)).flatMap(m=>m.controlIds));parts.push({id:part.raw.id,title:`Часть ${parts.length+1}`,text:part.raw.materialText,media:await this.taskMedia(part.frame,part.raw.media),fields,unmappedControls:part.raw.controls.filter(c=>part.raw.ungrouped.includes(c.id)&&!mapped.has(c.id)).map(c=>({id:c.id,label:c.label,context:part.raw.text.slice(0,8192),selected:Array.isArray(c.value)?c.value.length>0:null}))});}
    if(this.identity()?.suiteId!==identity.suiteId)throw new WorkerError('STALE_TASK');
    const semantic=parts.map(part=>({...part,media:part.media.map(({id,...asset})=>asset),fields:part.fields.map(({value,...field})=>field),unmappedControls:part.unmappedControls.map(({selected,...control})=>control)}));
    const verified=await this.capture(captured.pagination);if(verified.parts.length!==captured.parts.length||verified.parts.some((part,i)=>part.raw.fingerprint!==captured.parts[i]!.raw.fingerprint))throw new WorkerError('STALE_TASK');
    if(Date.parse(expiresAt)<=Date.now())throw new WorkerError('TASK_EXPIRED');
    const snapshot=TaskSetSchema.parse({...identity,parts,instruction,snapshotHash:sha256(JSON.stringify({...identity,parts:semantic,instructionHash:instruction.hash})),expiresAt,adapterVersion:'yang-sets-1'});
    this.lease={snapshot,raw:captured.parts.map(part=>part.raw),pagination:captured.pagination,consumed:false};return snapshot;
  }
  async mapFields(input:FieldMapping):Promise<TaskSet>{
    const lease=this.lease;if(!lease||lease.consumed||input.suiteId!==lease.snapshot.suiteId||input.snapshotHash!==lease.snapshot.snapshotHash)throw new WorkerError('STALE_TASK');
    const expected=new Set(lease.snapshot.parts.flatMap(p=>p.unmappedControls.map(c=>`${p.id}:${c.id}`)));const seen=new Set<string>();const fieldIds=new Set(lease.snapshot.parts.flatMap(p=>p.fields.map(f=>`${p.id}:${f.id}`)));
    for(const group of input.groups){if(group.controlIds.length<2||group.controlIds.length>32||!group.label.trim()||fieldIds.has(`${group.partId}:${group.fieldId}`))throw new WorkerError('INVALID_FIELD_MAPPING');fieldIds.add(`${group.partId}:${group.fieldId}`);for(const id of group.controlIds){const key=`${group.partId}:${id}`;if(!expected.has(key)||seen.has(key))throw new WorkerError('INVALID_FIELD_MAPPING');seen.add(key);}}
    if(seen.size!==expected.size)throw new WorkerError('INCOMPLETE_FIELD_MAPPING');const before=await this.capture(lease.pagination);if(before.parts.some((p,i)=>p.raw.fingerprint!==lease.raw[i]?.fingerprint)||before.parts.length!==lease.raw.length)throw new WorkerError('STALE_TASK');this.mappings.push(...input.groups);return this.snapshot();
  }
  private matches(input:SubmitPayload):Lease{
    this.check();const lease=this.lease;if(!lease||lease.consumed||input.poolId!==lease.snapshot.poolId||input.suiteId!==lease.snapshot.suiteId||input.snapshotHash!==lease.snapshot.snapshotHash||input.instructionHash!==lease.snapshot.instruction.hash)throw new WorkerError('STALE_TASK');if(lease.snapshot.expiresAt&&Date.parse(lease.snapshot.expiresAt)<=Date.now())throw new WorkerError('TASK_EXPIRED');return lease;
  }
  private sameValue(actual:TaskField['value']|undefined,expected:FieldAnswer['value']):boolean{return Array.isArray(actual)&&Array.isArray(expected)?actual.length===expected.length&&actual.every(value=>expected.includes(value)):actual===expected;}
  private async clickControl(root:ElementHandle<Node>,target:ElementHandle<Node>,raw:RawPart):Promise<void>{
    const guard=await root.evaluateHandle(partDom,{partId:raw.id,guard:{target:target as ElementHandle<Element>,fingerprint:raw.fingerprint}});
    try{this.check();await target.click({timeout:5000});const result=await guard.evaluate(value=>({checked:value.guard?.checked,allowed:value.guard?.allowed}));if(!result.checked||!result.allowed)throw new WorkerError('STALE_TASK');}
    finally{await guard.evaluate(value=>value.guard?.dispose()).catch(()=>undefined);await guard.dispose();}
  }
  async apply(input:SubmitPayload):Promise<TaskSet>{
    const lease=this.matches(input);const errors=validateAnswers(lease.snapshot,input.answers,false);if(errors.length)throw new WorkerError(errors[0]!);await this.authenticated();if((await this.instruction(input.poolId)).hash!==input.instructionHash)throw new WorkerError('INSTRUCTION_CHANGED');const frame=await this.frame();
    for(let i=0;i<lease.raw.length;i++){
      const original=lease.raw[i]!;await this.navigatePart(frame,lease.pagination>1?i:0,lease.pagination);const root=await frame.locator('form').nth(lease.pagination>1?0:i).elementHandle();if(!root)throw new WorkerError('STALE_TASK');let current=await root.evaluate(partDom,original.id);if(current.fingerprint!==original.fingerprint)throw new WorkerError('STALE_TASK');const part=lease.snapshot.parts[i]!;
      const answers=input.answers.filter(a=>a.partId===part.id).sort((a,b)=>part.fields.find(f=>f.id===a.fieldId)!.stage-part.fields.find(f=>f.id===b.fieldId)!.stage);
      for(const answer of answers){this.check();const field=part.fields.find(f=>f.id===answer.fieldId)!;const rawField=current.fields.find(f=>f.id===field.id);const mapping=this.mappings.find(m=>m.partId===part.id&&m.fieldId===field.id);const ids=rawField?.controlIds??mapping?.controlIds;if(!ids)throw new WorkerError('STALE_TASK');const controls=ids.map(id=>current.controls.find(c=>c.id===id)!);if(controls.some(c=>!c))throw new WorkerError('STALE_TASK');
        if(this.fields(current,input.poolId).some(f=>f.required&&f.stage<field.stage&&(f.value===null||f.value===''||Array.isArray(f.value)&&!f.value.length)))throw new WorkerError('EARLIER_STAGE_INCOMPLETE');
        const locator=(index:number)=>frame.locator('form').nth(lease.pagination>1?0:i).locator(CONTROL_SELECTOR).nth(index);
        if(field.kind==='TEXT'||field.kind==='NUMBER'){if(field.kind==='NUMBER'&&rawField?.step!==null&&rawField?.step!==undefined&&Math.abs(((Number(answer.value)-(rawField.min??0))/rawField.step)%1)>1e-8)throw new WorkerError('INVALID_FIELD_VALUE');await locator(controls[0]!.index).fill(String(answer.value));}
        else if(controls.length===1&&controls[0]!.kind==='select'){const values=Array.isArray(answer.value)?answer.value:[String(answer.value)];await locator(controls[0]!.index).selectOption(values.map(id=>controls[0]!.options.find(o=>o.id===id)!.value));}
        else{const values=Array.isArray(answer.value)?answer.value:[String(answer.value)];for(const control of controls){const selected=Array.isArray(control.value)&&control.value.includes(control.id);const desired=values.includes(control.id);if(selected===desired||field.kind==='SINGLE_CHOICE'&&!desired)continue;const target=await locator(control.index).elementHandle();if(!target)throw new WorkerError('STALE_TASK');await this.clickControl(root,target,current);}}
        current=await root.evaluate(partDom,original.id);if(current.contentFingerprint!==original.contentFingerprint||original.controls.some(control=>!current.controls.some(c=>c.id===control.id)))throw new WorkerError('STALE_TASK');const refreshed=this.fields(current,input.poolId).find(f=>f.id===field.id);if(!refreshed||!this.sameValue(refreshed.value,answer.value))throw new WorkerError('ANSWER_READBACK_FAILED');
      }
    }return this.snapshot();
  }
  async submit(input:SubmitPayload):Promise<SubmitResult>{
    const lease=this.matches(input);const key=`${input.poolId}:${input.suiteId}`;if(this.attempted.has(key))throw new WorkerError('SUBMIT_ALREADY_ATTEMPTED');const errors=validateAnswers(lease.snapshot,input.answers,true);if(errors.length)throw new WorkerError(errors[0]!);
    const current=await this.snapshot();if(current.snapshotHash!==input.snapshotHash||current.instruction.hash!==input.instructionHash)throw new WorkerError('STALE_TASK');for(const answer of input.answers){const field=current.parts.find(p=>p.id===answer.partId)?.fields.find(f=>f.id===answer.fieldId);if(!this.sameValue(field?.value,answer.value))throw new WorkerError('ANSWER_READBACK_FAILED');}
    const submit=this.page.getByRole('button',{name:/^(Отправить|Send)$/});if(await submit.count()!==1)throw new WorkerError('SUBMIT_UNAVAILABLE');const target=await submit.elementHandle();if(!target)throw new WorkerError('SUBMIT_UNAVAILABLE');
    const guard=await target.evaluateHandle((target,expected)=>{
      const frameSources=Array.from(document.querySelectorAll('iframe')).map(e=>e.getAttribute('src'));const state={checked:false,allowed:false,dispose:()=>document.removeEventListener('click',listener,true)};
      const listener=(event:Event)=>{if(event.target!==target&&!target.contains(event.target as Node))return;state.checked=true;state.allowed=event.isTrusted&&target.isConnected&&location.origin===expected.origin&&location.pathname===expected.path&&JSON.stringify(Array.from(document.querySelectorAll('iframe')).map(e=>e.getAttribute('src')))===JSON.stringify(frameSources);if(!state.allowed){event.preventDefault();event.stopImmediatePropagation();}};
      document.addEventListener('click',listener,true);return state;
    },{origin:this.origin,path:new URL(this.page.url()).pathname});this.check();this.attempted.add(key);this.lease!.consumed=true;
    let held=false;let observer:JSHandle<{changed:boolean;dispose:()=>void}>|null=null;
    try{
      await target.scrollIntoViewIfNeeded({timeout:5000});const box=await target.boundingBox();if(!box)throw new WorkerError('SUBMIT_UNAVAILABLE');const point={x:box.x+box.width/2,y:box.y+box.height/2};await this.page.mouse.move(point.x,point.y);await this.page.mouse.down();held=true;
      // Pointer handlers may change the form. Re-read every part before the only click is completed.
      const deadline=Date.now()+5000;const final=await this.capture(lease.pagination,true,deadline);if(this.identity()?.suiteId!==input.suiteId||final.parts.length!==this.lease!.raw.length||final.parts.some((part,i)=>part.raw.fingerprint!==this.lease!.raw[i]!.fingerprint))throw new WorkerError('STALE_TASK');
      for(const answer of input.answers){const raw=final.parts.find(p=>p.raw.id===answer.partId)?.raw;const field=raw?this.fields(raw,input.poolId).find(f=>f.id===answer.fieldId):null;if(!this.sameValue(field?.value,answer.value))throw new WorkerError('ANSWER_READBACK_FAILED');}
      const frame=await this.frame();observer=await frame.evaluateHandle(()=>{const state={changed:false,dispose:()=>{watcher.disconnect();document.removeEventListener('input',change,true);document.removeEventListener('change',change,true);}};const change=()=>{state.changed=true;};const watcher=new MutationObserver(change);watcher.observe(document.documentElement,{subtree:true,attributes:true,childList:true,characterData:true});document.addEventListener('input',change,true);document.addEventListener('change',change,true);return state;});
      const onTarget=await target.evaluate((element,point)=>{const at=document.elementFromPoint(point.x,point.y);return at===element||!!at&&element.contains(at);},point);if(!onTarget)throw new WorkerError('SUBMIT_UNAVAILABLE');this.check();
      if(Date.now()>deadline||await observer.evaluate(state=>state.changed))throw new WorkerError('STALE_TASK');
      await this.page.mouse.up();held=false;const permission=await guard.evaluate(state=>({checked:state.checked,allowed:state.allowed})).catch(()=>null);if(permission&&!permission.allowed)return {outcome:'UNKNOWN',code:'SUBMIT_GUARD_CHANGED'};await this.page.waitForFunction(({suiteId,origin})=>{if(location.origin!==origin)return true;const text=document.body.textContent??'';return /Задание отправлено|Ответы отправлены|Задания закончились|Все задания выполнены|Ответы приняты/.test(text)||/^\/task\/[^/]+\/[^/]+/.test(location.pathname)&&!location.pathname.endsWith('/'+suiteId);},{suiteId:input.suiteId,origin:this.origin},{timeout:this.options.verificationTimeoutMs??10_000});
      if((await this.session()).state!=='READY')return {outcome:'UNKNOWN',code:'SUBMIT_ACK_UNCONFIRMED'};const next=this.identity();if(next&&next.suiteId!==input.suiteId){await this.media.retain(this.instructionAssets);return {outcome:'SUBMITTED',nextSuiteId:next.suiteId};}const text=await this.page.locator('body').innerText();if(/Задания закончились|Все задания выполнены/.test(text)){await this.media.retain(this.instructionAssets);return {outcome:'COMPLETE'};}if(/Задание отправлено|Ответы отправлены|Ответы приняты/.test(text)){await this.media.retain(this.instructionAssets);return {outcome:'SUBMITTED'};}return {outcome:'UNKNOWN',code:'SUBMIT_ACK_UNCONFIRMED'};
    }catch{return {outcome:'UNKNOWN',code:held?'SUBMIT_GUARD_CHANGED':'SUBMIT_ACK_UNCONFIRMED'};}finally{if(held){await this.page.mouse.move(-10,-10).catch(()=>undefined);await this.page.mouse.up().catch(()=>undefined);}await observer?.evaluate(state=>(state as {dispose:()=>void}).dispose()).catch(()=>undefined);await observer?.dispose().catch(()=>undefined);await guard.evaluate(state=>state.dispose()).catch(()=>undefined);await guard.dispose().catch(()=>undefined);}
  }
}
