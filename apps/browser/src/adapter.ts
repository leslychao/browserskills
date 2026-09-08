import type { ElementHandle, Frame, Page } from 'playwright';
import type { InstructionBlock, MediaAsset, SubmitResult, TaskSnapshot, WorkerCommand } from '@browserskills/contracts';
import { TaskSnapshotSchema } from '@browserskills/contracts';
import { MediaStore, fetchOriginal, sha256 } from './media.js';
import { WorkerError } from './errors.js';

/** Source-owned, reviewed template descriptors. Never populated from HTTP, page data or model output. */
export interface TemplateProfile {
  id:string; origin:string; mediaOrigins:string[];
  frame?:{selector:string;origin:string};
  root:string; instructions:string[]; instructionScope?:'top'|'task'; question:string;
  options:string; submit:string; image?:string; audio?:string;
  taskAttribute:string; projectAttribute:string; expiresAttribute?:string;
  success?:string; error?:string; complete?:string;
}

/** No authenticated template has been verified yet. Fixtures are deliberately absent here. */
export const verifiedYandexProfiles: readonly TemplateProfile[] = [];
export const YANDEX_ORIGIN = 'https://tasks.yandex.ru';

type RawBlock={type:'text';text:string}|{type:'image'|'audio';url:string;caption?:string};
interface DomTask {
  projectId:string;taskId:string;question:string;options:Array<{id:string;label:string}>;
  imageUrl:string|null;audioUrl:string|null;expiresAt:string|null;selected:string[];fingerprint:string;
}
interface Lease {snapshot:TaskSnapshot;root:ElementHandle<Element>;submit:ElementHandle<Element>;options:ElementHandle<Element>[];frame:Frame;
  profile:TemplateProfile;fingerprint:string;instructionFingerprint:string;consumed:boolean;}
type Submission = NonNullable<WorkerCommand['payload']>;

/** Keeps full instruction structure and material order; unsupported links fail rather than disappear. */
export function instructionDom(selectors:string[]):RawBlock[] {
  const blocks:RawBlock[]=[];let text='';
  const flush=()=>{const value=text.replace(/\r\n/g,'\n').trim();if(value)blocks.push({type:'text',text:value});text='';};
  let textSize=0;
  const walk=(node:Node):void=>{
    if(node.nodeType===Node.TEXT_NODE){text+=node.textContent??'';textSize+=(node.textContent??'').length;if(textSize>64_000)throw new Error('CONTEXT_TOO_LARGE');return;}
    if(!(node instanceof Element))return;
    const tag=node.tagName.toLowerCase();
    if(['script','style','noscript'].includes(tag))return;
    if(['iframe','video','canvas','object','embed'].includes(tag))throw new Error('INSTRUCTIONS_UNSUPPORTED');
    if(tag==='img'||tag==='audio'){
      const media=node as HTMLImageElement|HTMLAudioElement;
      const url=media.currentSrc||media.getAttribute('src')||node.querySelector('source')?.getAttribute('src');
      if(!url)throw new Error('INSTRUCTIONS_INCOMPLETE');
      if(tag==='img'&&(!(media as HTMLImageElement).complete||!(media as HTMLImageElement).naturalWidth))throw new Error('MEDIA_NOT_READY');
      flush();blocks.push({type:tag==='img'?'image':'audio',url:new URL(url,location.href).href,
        ...(node.getAttribute('alt')||node.getAttribute('aria-label')?{caption:node.getAttribute('alt')||node.getAttribute('aria-label')!}:{})});return;
    }
    if(tag==='a'){
      const href=node.getAttribute('href');
      if(href&&!href.startsWith('#')){
        const url=new URL(href,location.href);
        const type=node.getAttribute('type')??'';
        const kind=type.startsWith('image/')||/\.(png|jpe?g|webp|gif)$/i.test(url.pathname)?'image'
          :type.startsWith('audio/')||/\.(wav|mp3|ogg|webm|flac|m4a)$/i.test(url.pathname)?'audio':null;
        if(!kind)throw new Error('INSTRUCTIONS_LINK_UNSUPPORTED');
        flush();blocks.push({type:kind,url:url.href,caption:(node.textContent??'').trim()});return;
      }
    }
    if(['p','div','section','article','h1','h2','h3','h4','h5','h6','tr','blockquote','pre'].includes(tag))text+='\n';
    if(tag==='li')text+='\n- ';
    if(tag==='br')text+='\n';
    for(const child of node.childNodes)walk(child);
    if(['p','div','section','article','h1','h2','h3','h4','h5','h6','tr','blockquote','pre','li'].includes(tag))text+='\n';
  };
  for(const selector of selectors){const matches=document.querySelectorAll(selector);if(matches.length!==1)throw new Error('INSTRUCTIONS_INCOMPLETE');walk(matches[0]!);flush();}
  if(!blocks.length||blocks.length>256)throw new Error('INSTRUCTIONS_INCOMPLETE');
  return blocks;
}

/** One bound whole task. Guard executes this same extractor at the actual trusted click event. */
export function taskDom(root:Element,input:{profile:TemplateProfile;guard?:{target:Element;fingerprint:string;instructionSelectors:string[];instructionFingerprint:string;requiredSelection?:string}}):DomTask&{guard?:{checked:boolean;allowed:boolean;dispose:()=>void}} {
  const p=input.profile;
  const fail=(code:string):never=>{throw new Error(code);};
  const unique=(selector:string):Element=>{const elements=root.matches(selector)?[root]:Array.from(root.querySelectorAll(selector));if(elements.length!==1)fail('UNSUPPORTED_TASK');return elements[0]!;};
  if(!root.isConnected||document.querySelectorAll(p.root).length!==1||document.querySelector(p.root)!==root)fail('STALE_TASK');
  if(location.origin!==(p.frame?.origin??p.origin))fail('UNSUPPORTED_ORIGIN');
  if(root.querySelector('textarea,select,input:not([type="radio"]):not([type="hidden"]):not([type="submit"]):not([type="button"]),[contenteditable="true"],video,canvas,iframe,object,embed'))fail('UNSUPPORTED_TASK');
  const choices=Array.from(root.querySelectorAll(p.options));
  const all=Array.from(root.querySelectorAll('input[type="radio"],[role="radio"],button[aria-pressed]'));
  if(choices.length<2||choices.length>10||all.length!==choices.length||all.some(e=>!choices.includes(e)))fail('UNSUPPORTED_TASK');
  const native=choices.every(e=>e instanceof HTMLInputElement&&e.type==='radio');
  const aria=choices.every(e=>e.matches('[role="radio"],button[aria-pressed]'));
  if(!native&&!aria)fail('UNSUPPORTED_TASK');
  if(native){
    const radios=choices as HTMLInputElement[];const first=radios[0]!;
    if(!first.name||radios.some(e=>e.name!==first.name||e.form!==first.form))fail('UNSUPPORTED_TASK');
    if(first.form&&Array.from(first.form.querySelectorAll('input[type="radio"]')).some(e=>!choices.includes(e)))fail('UNSUPPORTED_TASK');
  }else{
    const group=choices[0]!.closest('[role="radiogroup"],[role="group"]');
    if(!group||choices.some(e=>e.closest('[role="radiogroup"],[role="group"]')!==group))fail('UNSUPPORTED_TASK');
  }
  const selected:string[]=[];
  const options=choices.map((choice,index)=>{
    const radio=choice instanceof HTMLInputElement?choice:null;
    if(radio?.disabled||choice.getAttribute('aria-disabled')==='true')fail('UNSUPPORTED_TASK');
    const label=(choice.getAttribute('aria-label')||(radio?.labels?.length?Array.from(radio.labels).map(e=>e.textContent).join(' '):choice.textContent)||'').trim();
    const id=radio?.value||choice.getAttribute('data-option-id')||`option-${index+1}`;
    if(!label||label.length>2048||!id||id.length>256)fail('UNSUPPORTED_TASK');
    if(radio?.checked||choice.getAttribute('aria-checked')==='true'||choice.getAttribute('aria-pressed')==='true')selected.push(id);
    return {id,label};
  });
  if(new Set(options.map(o=>o.id)).size!==options.length)fail('UNSUPPORTED_TASK');
  const question=(unique(p.question).textContent??'').trim();if(question.length>64_000)fail('CONTEXT_TOO_LARGE');
  const image=p.image?root.querySelector(p.image):null;const audio=p.audio?root.querySelector(p.audio):null;
  if(root.querySelectorAll('img').length>(image?1:0)||root.querySelectorAll('audio').length>(audio?1:0))fail('UNSUPPORTED_TASK');
  if(image&&(!(image instanceof HTMLImageElement)||!image.complete||!image.naturalWidth))fail('MEDIA_NOT_READY');
  if(audio&&!(audio instanceof HTMLAudioElement))fail('UNSUPPORTED_AUDIO');
  const imageUrl=image?(image as HTMLImageElement).currentSrc:null;
  const audioUrl=audio?((audio as HTMLAudioElement).currentSrc||audio.getAttribute('src')||audio.querySelector('source')?.getAttribute('src')||null):null;
  if((image&&!imageUrl)||(audio&&!audioUrl))fail('MEDIA_NOT_READY');
  if(!question&&!image&&!audio)fail('UNSUPPORTED_TASK');
  const taskId=root.getAttribute(p.taskAttribute);const projectId=root.getAttribute(p.projectAttribute);
  if(!taskId||!projectId||taskId.length>256||projectId.length>256)fail('UNSUPPORTED_TASK');
  const expiresAt=p.expiresAttribute?root.getAttribute(p.expiresAttribute):null;
  if(expiresAt&&(!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=Date.now()))fail('TASK_EXPIRED');
  const value={projectId:projectId!,taskId:taskId!,question,options,imageUrl,audioUrl:audioUrl?new URL(audioUrl,location.href).href:null,expiresAt};
  const result:DomTask&{guard?:{checked:boolean;allowed:boolean;dispose:()=>void}}={...value,selected,fingerprint:JSON.stringify(value)};
  if(input.guard){
    const expected=input.guard;const state={checked:false,allowed:false,dispose:()=>document.removeEventListener('click',guard,true)};
    const guard=(event:Event)=>{
      if(!(event.target instanceof Node)||!expected.target.contains(event.target))return;
      state.checked=true;
      try{
        const current=taskDom(root,{profile:p});
        const instructionFingerprint=JSON.stringify(expected.instructionSelectors.map(selector=>{
          const matches=document.querySelectorAll(selector);return matches.length===1?matches[0]!.outerHTML:null;
        }));
        state.allowed=current.fingerprint===expected.fingerprint&&expected.target.isConnected
          &&instructionFingerprint===expected.instructionFingerprint
          &&(!expected.requiredSelection||(current.selected.length===1&&current.selected[0]===expected.requiredSelection));
      }catch{state.allowed=false;}
      if(!state.allowed){event.preventDefault();event.stopImmediatePropagation();}
      state.dispose();
    };
    document.addEventListener('click',guard,true);result.guard=state;
  }
  return result;
}

const materialKey=(asset:MediaAsset|null)=>asset?{kind:asset.kind,mimeType:asset.mimeType,sha256:asset.sha256,durationMs:asset.durationMs??null}:null;

export class FixedAdapter {
  private lease:Lease|null=null;
  private readonly attempted=new Set<string>();
  private readonly abort=new AbortController();
  constructor(private readonly page:Page,private readonly media:MediaStore,private readonly profiles:readonly TemplateProfile[]=verifiedYandexProfiles,
    private readonly options:{verificationTimeoutMs?:number}={}){}

  cancel():void {this.abort.abort();this.lease=null;}
  private check():void{if(this.abort.signal.aborted||this.page.isClosed())throw new WorkerError('STOPPED');}
  private async choose():Promise<{profile:TemplateProfile;frame:Frame}> {
    this.check();const origin=new URL(this.page.url()).origin;
    if(origin!==YANDEX_ORIGIN&&!this.profiles.some(p=>p.origin===origin))throw new WorkerError('UNSUPPORTED_ORIGIN',422);
    for(const profile of this.profiles){
      if(profile.origin!==origin)continue;
      let frame=this.page.mainFrame();
      if(profile.frame){const matches=await this.page.$$(profile.frame.selector);if(matches.length!==1)continue;
        const child=await matches[0]!.contentFrame();if(!child||child.parentFrame()!==this.page.mainFrame()||new URL(child.url()).origin!==profile.frame.origin)continue;frame=child;}
      if(await frame.locator(profile.root).count()===1)return {profile,frame};
    }
    throw new WorkerError('UNSUPPORTED_TEMPLATE',422);
  }
  private async instructionFingerprint(frame:Frame,profile:TemplateProfile):Promise<string>{
    return frame.evaluate(selectors=>JSON.stringify(selectors.map(selector=>{const matches=document.querySelectorAll(selector);return matches.length===1?matches[0]!.outerHTML:null;})),profile.instructions);
  }
  private async extract(frame:Frame,profile:TemplateProfile,root:ElementHandle<Element>):Promise<{snapshot:TaskSnapshot;dom:DomTask;instructionFingerprint:string}> {
    this.check();
    const dom=await root.evaluate(taskDom,{profile}).catch(error=>{throw this.domError(error);});
    const instructionsFrame=profile.instructionScope==='top'?this.page.mainFrame():frame;
    // Cross-origin instruction guards require a verified profile-specific bridge; do not weaken them.
    if(instructionsFrame!==frame)throw new WorkerError('UNSUPPORTED_INSTRUCTION_FRAME',422);
    const instructionFingerprint=await this.instructionFingerprint(instructionsFrame,profile);
    const raw=await instructionsFrame.evaluate(instructionDom,profile.instructions).catch(error=>{throw this.domError(error);});
    const blocks:InstructionBlock[]=[];
    const asset=async(url:string,kind:'image'|'audio',limit=60_000):Promise<MediaAsset>=>this.media.put(await fetchOriginal(frame,this.page.context(),url,profile.mediaOrigins,this.abort.signal),kind,limit);
    for(const block of raw){this.check();if(block.type==='text')blocks.push(block);else blocks.push({type:block.type,asset:await asset(block.url,block.type,120_000),...(block.caption?{caption:block.caption}:{})});}
    const image=dom.imageUrl?await asset(dom.imageUrl,'image'):null;
    const audio=dom.audioUrl?await asset(dom.audioUrl,'audio'):null;
    const audioMs=(audio?.durationMs??0)+blocks.reduce((total,b)=>total+(b.type==='audio'?(b.asset.durationMs??0):0),0);
    if(audioMs>120_000)throw new WorkerError('AUDIO_TOTAL_TOO_LONG',422);
    const instructionHash=sha256(JSON.stringify(blocks.map(b=>b.type==='text'?b:{type:b.type,asset:materialKey(b.asset),caption:b.caption??null})));
    const instruction={sourceKey:`${profile.id}:${dom.projectId}`,hash:instructionHash,blocks};
    const snapshotHash=sha256(JSON.stringify({projectId:dom.projectId,taskId:dom.taskId,question:dom.question,instructionHash,image:materialKey(image),audio:materialKey(audio),options:dom.options,expiresAt:dom.expiresAt,adapterVersion:profile.id}));
    const snapshot=TaskSnapshotSchema.parse({projectId:dom.projectId,taskId:dom.taskId,question:dom.question,instruction,image,audio,options:dom.options,snapshotHash,expiresAt:dom.expiresAt,adapterVersion:profile.id});
    this.check();
    if((await root.evaluate(taskDom,{profile})).fingerprint!==dom.fingerprint||await this.instructionFingerprint(frame,profile)!==instructionFingerprint)throw new WorkerError('STALE_TASK');
    return {snapshot,dom,instructionFingerprint};
  }
  private domError(error:unknown):WorkerError {
    const message=error instanceof Error?error.message:'';
    const code=['STALE_TASK','UNSUPPORTED_TASK','UNSUPPORTED_ORIGIN','INSTRUCTIONS_INCOMPLETE','INSTRUCTIONS_UNSUPPORTED','INSTRUCTIONS_LINK_UNSUPPORTED','CONTEXT_TOO_LARGE','MEDIA_NOT_READY','UNSUPPORTED_AUDIO','TASK_EXPIRED'].find(code=>message.includes(code));
    return new WorkerError(code??'STALE_TASK',422);
  }
  async snapshot():Promise<TaskSnapshot>{
    const {profile,frame}=await this.choose();const root=await frame.$(profile.root);if(!root)throw new WorkerError('UNSUPPORTED_TASK',422);
    try{
      const extracted=await this.extract(frame,profile,root);
      const key=`${extracted.snapshot.projectId}:${extracted.snapshot.taskId}`;
      if(this.attempted.has(key))throw new WorkerError('ALREADY_ATTEMPTED');
      const submits=await root.$$(profile.submit);if(submits.length!==1)throw new WorkerError('UNSUPPORTED_TASK',422);
      const options=await root.$$(profile.options);
      await this.releaseLease();
      this.lease={snapshot:extracted.snapshot,root,submit:submits[0]!,options,frame,profile,fingerprint:extracted.dom.fingerprint,instructionFingerprint:extracted.instructionFingerprint,consumed:false};
      await this.media.retain(new Set([extracted.snapshot.image?.id,extracted.snapshot.audio?.id,...extracted.snapshot.instruction.blocks.flatMap(b=>b.type==='text'?[]:[b.asset.id])].filter((id):id is string=>!!id)));
      return extracted.snapshot;
    }catch(error){await root.dispose();throw error;}
  }
  private async releaseLease():Promise<void>{
    const lease=this.lease;this.lease=null;
    if(lease)await Promise.all([lease.root,lease.submit,...lease.options].map(handle=>handle.dispose().catch(()=>undefined)));
  }
  private async marker(frame:Frame,selector:string|undefined):Promise<string|null>{
    if(!selector)return null;
    const locator=frame.locator(selector);if(await locator.count()!==1||!await locator.isVisible())return null;
    return locator.evaluate(el=>JSON.stringify({text:el.textContent,ack:el.getAttribute('data-submission-id')}));
  }
  private async click(lease:Lease,target:ElementHandle<Element>,requiredSelection?:string):Promise<void>{
    this.check();
    const guard=await lease.root.evaluateHandle(taskDom,{profile:lease.profile,guard:{target,fingerprint:lease.fingerprint,instructionSelectors:lease.profile.instructions,instructionFingerprint:lease.instructionFingerprint,...(requiredSelection?{requiredSelection}:{})}});
    try{
      this.check();await target.click({timeout:3_000,noWaitAfter:true});
      const result=await guard.evaluate(result=>({checked:result.guard?.checked,allowed:result.guard?.allowed}));
      if(!result.checked||!result.allowed)throw new WorkerError('STALE_TASK');
    }finally{await guard.evaluate(result=>result.guard?.dispose()).catch(()=>undefined);await guard.dispose().catch(()=>undefined);}
  }
  async submit(payload:Submission):Promise<SubmitResult>{
    this.check();const lease=this.lease;
    if(!lease||lease.consumed)throw new WorkerError('ALREADY_ATTEMPTED');
    lease.consumed=true;
    const expected=lease.snapshot;
    if(payload.taskId!==expected.taskId||payload.snapshotHash!==expected.snapshotHash||payload.instructionHash!==expected.instruction.hash)throw new WorkerError('STALE_TASK');
    const selectedIndex=expected.options.findIndex(option=>option.id===payload.optionId);if(selectedIndex<0)throw new WorkerError('INVALID_OPTION',422);
    const {profile,frame}=await this.choose();if(profile!==lease.profile||frame!==lease.frame)throw new WorkerError('STALE_TASK');
    const fresh=await this.extract(frame,profile,lease.root).catch(()=>{throw new WorkerError('STALE_TASK');});
    if(fresh.snapshot.snapshotHash!==expected.snapshotHash||fresh.snapshot.instruction.hash!==expected.instruction.hash)throw new WorkerError('STALE_TASK');
    if(await this.marker(frame,profile.error))throw new WorkerError('VALIDATION_ERROR',422);
    await this.click(lease,lease.options[selectedIndex]!);
    const current=await lease.root.evaluate(taskDom,{profile}).catch(()=>{throw new WorkerError('STALE_TASK');});
    if(current.fingerprint!==lease.fingerprint||current.selected.length!==1||current.selected[0]!==payload.optionId)throw new WorkerError('STALE_TASK');
    const successBefore=await this.marker(frame,profile.success);const completeBefore=await this.marker(frame,profile.complete);
    const key=`${expected.projectId}:${expected.taskId}`;this.attempted.add(key);
    try{
      await this.click(lease,lease.submit,payload.optionId);
      const deadline=Date.now()+(this.options.verificationTimeoutMs??8_000);
      do{
        this.check();
        if(await this.marker(frame,profile.error)){this.attempted.delete(key);return {outcome:'REJECTED',code:'VALIDATION_ERROR'};}
        const complete=await this.marker(frame,profile.complete);if(complete!==null&&complete!==completeBefore){await this.media.clear();return {outcome:'COMPLETE'};}
        const root=await frame.$(profile.root);
        if(root){try{const next=await root.evaluate(taskDom,{profile});if(next.projectId===expected.projectId&&next.taskId!==expected.taskId){await this.media.clear();return {outcome:'SUBMITTED',nextTaskId:next.taskId};}}finally{await root.dispose();}}
        const success=await this.marker(frame,profile.success);if(success!==null&&success!==successBefore){await this.media.clear();return {outcome:'SUBMITTED'};}
        await new Promise(resolve=>setTimeout(resolve,50));
      }while(Date.now()<deadline);
    }catch{/* Never retry a dispatched click or infer acceptance from a transport failure. */}
    return {outcome:'UNKNOWN',code:'RESULT_UNKNOWN'};
  }
}
