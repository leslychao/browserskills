/** Functions in this file are self-contained: Playwright serializes them into the observed document. */
export interface RawMedia { kind:'image'|'audio'; url:string; caption:string; }
export interface RawControl { id:string; label:string; kind:'radio'|'checkbox'|'button'|'text'|'number'|'select'; index:number; value:string|number|string[]|null; options:Array<{id:string;label:string;value:string}>; required:boolean; min:number|null; max:number|null; step:number|null; maxLength:number|null; }
export interface RawField { id:string; label:string; kind:'SINGLE_CHOICE'|'MULTIPLE_CHOICE'|'TEXT'|'NUMBER'; required:boolean; controlIds:string[]; options:Array<{id:string;label:string}>; min:number|null; max:number|null; step:number|null; }
export interface RawPart { id:string; text:string; materialText:string; fields:RawField[]; controls:RawControl[]; media:RawMedia[]; ungrouped:string[]; fingerprint:string;contentFingerprint:string;guard?:{checked:boolean;allowed:boolean;dispose:()=>void}; }
export interface RawInstruction { blocks:Array<{type:'text';text:string}|{type:'image'|'audio';url:string;caption:string}>; documents:string[]; }

export function authDom():'LOGIN_REQUIRED'|'SECOND_FACTOR_REQUIRED'|'CONNECTED'|'UNKNOWN' {
  const visible=(e:Element)=>{for(let node:Element|null=e;node;node=node.parentElement)if(node.matches('[hidden],[aria-hidden="true"]')||getComputedStyle(node).display==='none'||getComputedStyle(node).visibility==='hidden')return false;return true;};
  const inputs=Array.from(document.querySelectorAll('input')).filter(visible) as HTMLInputElement[];
  if(inputs.some(e=>e.autocomplete==='one-time-code'||/^(otp|code|verification_code)$/i.test(e.name)||e.inputMode==='numeric'&&e.maxLength===6))return 'SECOND_FACTOR_REQUIRED';
  if(inputs.some(e=>e.type==='password'||e.autocomplete==='username'||/^login$/i.test(e.name)))return 'LOGIN_REQUIRED';
  const text=(document.body?.textContent??'').replace(/\s+/g,' ');
  const anchors=Array.from(document.querySelectorAll('a[href]'));
  const catalogue=anchors.some(e=>e.getAttribute('href')==='/profile')&&anchors.some(e=>['/','/?activeTab=all'].includes(e.getAttribute('href')??''))&&!!document.querySelector('[role="radiogroup"] [role="radio"],input[type="radio"][value="all"]')
    ||anchors.some(e=>/activeTab=(all|active)/.test(e.getAttribute('href')??''))&&(/В работе|Избранн|Скрыт/.test(text));
  const buttons=Array.from(document.querySelectorAll('button')).filter(visible);
  const submit=buttons.some(e=>/^(Отправить|Send)$/.test(e.textContent?.trim()??''));
  const instructionAndTimer=buttons.some(e=>(e.textContent?.trim()??'')==='Инструкция')&&Array.from(document.querySelectorAll('.task-info__values-time')).some(visible);
  const task=/^\/task\/[^/]+\/[^/]+/.test(location.pathname)&&(submit||instructionAndTimer)&&!!document.querySelector('iframe');
  if(catalogue||task)return 'CONNECTED';
  if(Array.from(document.querySelectorAll('button,a')).some(e=>visible(e)&&/^Войти$/.test(e.textContent?.trim()??'')))return 'LOGIN_REQUIRED';
  return 'UNKNOWN';
}

export function catalogueDom():Array<{poolId:string;title:string;price:string|null;unit:string|null;available:boolean;training:boolean;exam:boolean;cardIndex:number;modalities:Array<'text'|'image'|'audio'>}> {
  const cards=Array.from(document.querySelectorAll('li')).filter(e=>e.querySelector('h1,h2,h3,h4,h5,h6')&&Array.from(e.querySelectorAll('button,a')).some(b=>/^(Приступить|Продолжить|Инструкция)$/.test(b.textContent?.trim()??'')));
  if(cards.length>500)throw new Error('CATALOGUE_TOO_LARGE');
  return cards.map((card,cardIndex)=>{
    const text=(card.textContent??'').replace(/\s+/g,' ').trim();
    const links=Array.from(card.querySelectorAll('a[href]')).map(e=>e.getAttribute('href')??'');
    const ids=links.map(href=>{try{return new URL(href,location.href).pathname.match(/^\/(?:instructions|task)\/([^/]+)(?:\/|$)/)?.[1];}catch{return undefined;}}).filter((id):id is string=>!!id);
    const unique=[...new Set(ids)];
    if(unique.length>1)throw new Error('CATALOGUE_ID_UNAVAILABLE');
    const price=text.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?|балл(?:а|ов)?)?\s*(за\s+(?:задание|набор))/i);
    const start=Array.from(card.querySelectorAll('button,a')).find(e=>/^(Приступить|Продолжить)$/.test(e.textContent?.trim()??''));
    const hints=Array.from(card.querySelectorAll('[aria-label],[title]')).map(e=>(e.getAttribute('aria-label')??'')+' '+(e.getAttribute('title')??'')).join(' ');
    const modalities:Array<'text'|'image'|'audio'>=[];if(/текст/i.test(hints))modalities.push('text');if(/картин|изображ|фото/i.test(hints))modalities.push('image');if(/аудио|звук|голос/i.test(hints))modalities.push('audio');
    return {poolId:unique[0]??'',title:(card.querySelector('h1,h2,h3,h4,h5,h6')!.textContent??'').trim(),price:price?price[1]!.replace(',','.'):null,unit:price?price[2]!:null,
      available:!!start&&!start.hasAttribute('disabled')&&start.getAttribute('aria-disabled')!=='true',training:/обучение|трениров/i.test(text),exam:/экзамен/i.test(text),cardIndex,modalities};
  });
}

export function instructionDom():RawInstruction {
  const result:RawInstruction={blocks:[],documents:[]};let text='';let size=0;
  const flush=()=>{const value=text.replace(/\r\n/g,'\n').trim();for(let offset=0;offset<value.length;){let end=Math.min(offset+262144,value.length);if(end<value.length&&/[\uD800-\uDBFF]/.test(value[end-1]!))end--;result.blocks.push({type:'text',text:value.slice(offset,end)});offset=end;}text='';};
  const walk=(node:Node):void=>{
    if(node.nodeType===Node.TEXT_NODE){text+=node.textContent??'';size+=(node.textContent??'').length;if(size>1_000_000)throw new Error('INSTRUCTIONS_TOO_LARGE');return;}
    if(!(node instanceof Element))return;
    const tag=node.tagName.toLowerCase();if(['script','style','noscript','nav'].includes(tag))return;
    if(['video','canvas','object','embed','iframe'].includes(tag))throw new Error('INSTRUCTIONS_UNSUPPORTED');
    if(tag==='audio'||tag==='img'){
      const element=node as HTMLImageElement|HTMLAudioElement;const src=element.currentSrc||element.getAttribute('src')||element.querySelector('source')?.getAttribute('src');
      if(!src)throw new Error('INSTRUCTION_INCOMPLETE');flush();result.blocks.push({type:tag==='img'?'image':'audio',url:new URL(src,location.href).href,caption:node.getAttribute('alt')??node.getAttribute('aria-label')??''});return;
    }
    if(tag==='a'){
      const href=node.getAttribute('href');if(href&&!href.startsWith('#')){
        const url=new URL(href,location.href);const kind=/\.(png|jpe?g|webp|gif)$/i.test(url.pathname)?'image':/\.(wav|mp3|ogg|webm|flac|m4a)$/i.test(url.pathname)?'audio':null;
        if(kind){flush();result.blocks.push({type:kind,url:url.href,caption:node.textContent?.trim()??''});return;}
        // Linked HTML is source material. Organisational and platform navigation links remain text only.
        if(/\.(html?|pdf)$/i.test(url.pathname))result.documents.push(url.href);
        else if(!/^(t\.me|telegram\.me|forms\.yandex\.ru|yang\.yandex-team\.ru)$/.test(url.hostname))throw new Error('INSTRUCTIONS_LINK_UNSUPPORTED');
      }
    }
    if(/^(p|div|section|article|h[1-6]|tr|blockquote|pre|li|details|summary)$/.test(tag))text+='\n';
    if(tag==='li'){
      const parent=node.parentElement;if(parent instanceof HTMLOListElement){const items=Array.from(parent.children).filter((e):e is HTMLLIElement=>e instanceof HTMLLIElement);let number=parent.hasAttribute('start')?parent.start:parent.reversed?items.length:1;for(const item of items){if(item.hasAttribute('value'))number=item.value;if(item===node)break;number+=parent.reversed?-1:1;}text+=`${number}. `;}else text+='- ';
    }
    if(tag==='br')text+='\n';if(tag==='td'||tag==='th')text+='\t';
    for(const child of node.childNodes)walk(child);
    if(/^(p|div|section|article|h[1-6]|tr|blockquote|pre|li|details|summary)$/.test(tag))text+='\n';
  };
  walk(document.body);flush();
  // Yang's voice instructions publish the required external HTML as plain text, not an anchor.
  for(const match of (document.body.textContent??'').matchAll(/https?:\/\/[^\s<>"']+\.html?(?:\?[^\s<>"']*)?/gi))result.documents.push(match[0]);
  if(!result.blocks.length||result.blocks.length>4096||result.documents.length>16)throw new Error('INSTRUCTION_INCOMPLETE');
  result.documents=[...new Set(result.documents)];return result;
}

export function partDom(root:Element,input:string|{partId:string;guard:{target:Element;fingerprint:string}}):RawPart {
  const partId=typeof input==='string'?input:input.partId;
  if(!root.isConnected)throw new Error('STALE_TASK');
  const visible=(e:Element)=>{for(let node:Element|null=e;node;node=node.parentElement)if(node.matches('[hidden],[aria-hidden="true"]')||getComputedStyle(node).display==='none'||getComputedStyle(node).visibility==='hidden')return false;return true;};
  if(Array.from(root.querySelectorAll('video,canvas,iframe,object,embed,input[type="file"],[contenteditable="true"]')).some(visible))throw new Error('UNSUPPORTED_TASK');
  const selector='input:not([type="hidden"]):not([type="submit"]):not([type="button"]),textarea,select,button[aria-pressed],[role="radio"],[role="checkbox"]';
  const all=Array.from(root.querySelectorAll(selector));const elements=all.filter(visible);
  if(!elements.length||elements.length>512)throw new Error('UNSUPPORTED_TASK');
  const label=(e:Element):string=>{
    const ids=(e.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean);const labelled=ids.map(id=>document.getElementById(id)?.textContent??'').join(' ').trim();
    const labels=(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement||e instanceof HTMLSelectElement)?Array.from(e.labels??[]).map(e=>{const clone=e.cloneNode(true) as Element;clone.querySelectorAll('input,textarea,select,script,style').forEach(child=>child.remove());return clone.textContent??'';}).join(' ').trim():'';
    return (e.getAttribute('aria-label')||labelled||labels||e.textContent||'').replace(/\s+/g,' ').trim();
  };
  const stableHash=(value:string)=>{let n=2166136261;for(let i=0;i<value.length;i++)n=Math.imul(n^value.charCodeAt(i),16777619);return (n>>>0).toString(16);};
  const keys=new Map<string,number>();
  const controls:RawControl[]=elements.map(e=>{
    const scope=e.closest('fieldset,[role="radiogroup"],[role="group"]');
    const key=JSON.stringify([e.tagName,e.getAttribute('type'),e.getAttribute('name'),e.matches('input[type="radio"],input[type="checkbox"]')?e.getAttribute('value'):null,label(e),scope?.getAttribute('aria-label')||scope?.querySelector('legend,h1,h2,h3,h4,h5,h6')?.textContent||'']);
    const occurrence=(keys.get(key)??0)+1;keys.set(key,occurrence);const id=`${partId}-c${stableHash(key)}-${occurrence}`;const isInput=e instanceof HTMLInputElement;
    const kind=isInput&&e.type==='radio'||e.getAttribute('role')==='radio'?'radio':isInput&&e.type==='checkbox'||e.getAttribute('role')==='checkbox'?'checkbox':e instanceof HTMLSelectElement?'select':e instanceof HTMLTextAreaElement||isInput&&['text','search','url','tel','email'].includes(e.type)?'text':isInput&&e.type==='number'?'number':e.matches('button[aria-pressed]')?'button':null;
    if(!kind||(e as HTMLInputElement).disabled||e.getAttribute('aria-disabled')==='true')throw new Error('UNSUPPORTED_TASK');
    const selected=isInput?e.checked:e.getAttribute('aria-checked')==='true'||e.getAttribute('aria-pressed')==='true';
    const options=e instanceof HTMLSelectElement?Array.from(e.options).filter(o=>!o.disabled&&o.value!=='').map((o,i)=>({id:`${id}-o${i+1}`,label:o.label.trim(),value:o.value})):[];
    const value=kind==='text'?(e as HTMLInputElement).value:kind==='number'?((e as HTMLInputElement).value===''?null:Number((e as HTMLInputElement).value)):kind==='select'?Array.from((e as HTMLSelectElement).selectedOptions).map(o=>options.find(p=>p.value===o.value)?.id).filter((id):id is string=>!!id):selected?[id]:[];
    const numeric=(attribute:string)=>{const val=e.getAttribute(attribute);return val!==null&&val!==''&&Number.isFinite(Number(val))?Number(val):null;};
    return {id,label:label(e),kind,index:all.indexOf(e),value,options,required:e.hasAttribute('required')||e.getAttribute('aria-required')==='true',min:numeric('min'),max:numeric('max'),step:numeric('step'),maxLength:numeric('maxlength')};
  });
  if(new Set(controls.map(c=>c.id)).size!==controls.length)throw new Error('AMBIGUOUS_FIELDS');
  const fields:RawField[]=[];const used=new Set<string>();const questionNodes=new Set<Element>();
  const groupLabel=(container:Element)=>{
    const explicit=container.getAttribute('aria-label')||(container.getAttribute('aria-labelledby')??'').split(/\s+/).map(id=>document.getElementById(id)?.textContent??'').join(' ').trim();
    const heading=container.querySelector('legend,h1,h2,h3,h4,h5,h6');
    if(explicit||heading)return (explicit||heading?.textContent||'').replace(/\s+/g,' ').trim();
    const copy=container.cloneNode(true) as Element;copy.querySelectorAll('label,input,button,select,textarea,audio,img').forEach(e=>e.remove());return (copy.textContent??'').replace(/\s+/g,' ').trim();
  };
  for(let i=0;i<elements.length;i++){
    const element=elements[i]!;const control=controls[i]!;if(used.has(control.id))continue;
    if(['text','number','select'].includes(control.kind)){
      const kind=control.kind==='number'?'NUMBER':control.kind==='text'?'TEXT':(element as HTMLSelectElement).multiple?'MULTIPLE_CHOICE':'SINGLE_CHOICE';
      if(!control.label||control.kind==='select'&&control.options.length<2)throw new Error('UNSUPPORTED_TASK');
      fields.push({id:`${control.id}-field`,kind,label:control.label,required:control.required,controlIds:[control.id],options:control.options.map(({id,label})=>({id,label})),min:control.min,max:control.max,step:control.step});used.add(control.id);continue;
    }
    let group:Element[]=[];let container:Element|null=element.closest('fieldset,[role="radiogroup"],[role="group"]');
    if(container&&!root.contains(container))container=null;
    if(element instanceof HTMLInputElement&&element.name){group=elements.filter(e=>e instanceof HTMLInputElement&&e.name===element.name&&e.type===element.type&&e.form===element.form);container=container??element.parentElement;}
    else if(container)group=elements.filter(e=>container!.contains(e)&&controls[elements.indexOf(e)]!.kind===control.kind);
    else {
      // The closest container shared by choices is useful only when it also carries question text.
      for(let parent=element.parentElement;parent&&parent!==root;parent=parent.parentElement){const candidates=elements.filter(e=>parent.contains(e));if(candidates.length>=2){if(candidates.every(e=>controls[elements.indexOf(e)]!.kind===control.kind)&&groupLabel(parent)){group=candidates;container=parent;}break;}}
    }
    if(group.length<2||group.length>32||!container||!groupLabel(container))continue;
    const members=group.map(e=>controls[elements.indexOf(e)]!);if(members.some(c=>used.has(c.id)||!c.label))throw new Error('AMBIGUOUS_FIELDS');
    fields.push({id:`${control.id}-field`,label:groupLabel(container),kind:control.kind==='checkbox'?'MULTIPLE_CHOICE':'SINGLE_CHOICE',required:members.some(c=>c.required)||control.kind!=='checkbox',controlIds:members.map(c=>c.id),options:members.map(c=>({id:c.id,label:c.label})),min:null,max:null,step:null});members.forEach(c=>used.add(c.id));
    const heading=container.querySelector('legend,h1,h2,h3,h4,h5,h6');if(heading)questionNodes.add(heading);
    for(const id of (container.getAttribute('aria-labelledby')??'').split(/\s+/)){const node=document.getElementById(id);if(node&&root.contains(node))questionNodes.add(node);}
  }
  const media:RawMedia[]=Array.from(root.querySelectorAll('img,audio')).filter(e=>e.tagName==='AUDIO'||visible(e)).map(e=>{const source=(e as HTMLImageElement|HTMLAudioElement).currentSrc||e.getAttribute('src')||e.querySelector('source')?.getAttribute('src');if(!source)throw new Error('MEDIA_NOT_READY');return {kind:e.tagName==='IMG'?'image':'audio',url:new URL(source,location.href).href,caption:e.getAttribute('alt')??e.getAttribute('aria-label')??''};});
  if(media.length>64)throw new Error('UNSUPPORTED_TASK');
  const copy=root.cloneNode(true) as Element;copy.querySelectorAll('script,style,noscript,input,textarea,select,[hidden],[aria-hidden="true"]').forEach(e=>e.remove());
  const text=(copy.textContent??'').replace(/\s+/g,' ').trim();if(text.length>100_000)throw new Error('CONTEXT_TOO_LARGE');
  const structure={id:partId,text,fields,controls:controls.map(({value,...c})=>c),media,ungrouped:controls.filter(c=>!used.has(c.id)).map(c=>c.id)};
  const materialCopy=root.cloneNode(true) as Element;const originals=[root,...root.querySelectorAll('*')],copies=[materialCopy,...materialCopy.querySelectorAll('*')];for(let i=1;i<originals.length;i++)if(questionNodes.has(originals[i]!)||!visible(originals[i]!))copies[i]!.remove();
  // Form groups may also contain the source article or dialogue. Remove field labels, not whole groups.
  materialCopy.querySelectorAll('script,style,noscript,legend,label,input,textarea,select,button,[hidden],[aria-hidden="true"]').forEach(e=>e.remove());
  const materialText=(materialCopy.textContent??'').replace(/\s+/g,' ').trim();
  const result:RawPart={...structure,controls,materialText,fingerprint:JSON.stringify(structure),contentFingerprint:JSON.stringify({text:materialText,media})};
  if(typeof input!=='string'){
    const guard={checked:false,allowed:false,dispose:()=>document.removeEventListener('click',listener,true)};
    const listener=(event:Event)=>{if(event.target!==input.guard.target&&!input.guard.target.contains(event.target as Node))return;guard.checked=true;try{guard.allowed=event.isTrusted&&root.isConnected&&input.guard.target.isConnected&&partDom(root,partId).fingerprint===input.guard.fingerprint;}catch{guard.allowed=false;}if(!guard.allowed){event.preventDefault();event.stopImmediatePropagation();}};
    document.addEventListener('click',listener,true);result.guard=guard;
  }
  return result;
}
