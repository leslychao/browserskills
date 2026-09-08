// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { instructionDom, taskDom } from '../src/adapter.js';
import { fixtureProfile } from './fixture-profile.js';

const profile=fixtureProfile(location.origin);
const root=()=>document.querySelector('#task')!;
const inspect=()=>taskDom(root(),{profile});
beforeEach(()=>{
  document.body.innerHTML='<section id="instructions"><h2>Rules</h2><p>Read words and background sound.</p></section><form id="task" data-task-id="t1" data-project-id="p1"><p id="question">Which is blue?</p><fieldset><label><input type="radio" name="answer" value="sky">Sky</label><label><input type="radio" name="answer" value="grass">Grass</label></fieldset><button id="submit" type="submit">Send</button></form>';
});

describe('whole-task DOM extraction boundaries',()=>{
  it('captures labels and stable identities independently from selection',()=>{
    const original=inspect();expect(original.options).toEqual([{id:'sky',label:'Sky'},{id:'grass',label:'Grass'}]);expect(original.taskId).toBe('t1');
    (document.querySelector('input') as HTMLInputElement).checked=true;
    const selected=inspect();expect(selected.selected).toEqual(['sky']);expect(selected.fingerprint).toBe(original.fingerprint);
  });
  it.each(['textarea','select','input type="text"','input type="checkbox"','video','canvas','iframe','div contenteditable="true"'])('rejects unsupported control %s',tag=>{
    root().insertAdjacentHTML('beforeend',`<${tag}></${tag.split(' ')[0]}>`);expect(inspect).toThrow('UNSUPPORTED_TASK');
  });
  it('rejects a detached or duplicated whole-task root',()=>{
    const detached=root();detached.remove();expect(()=>taskDom(detached,{profile})).toThrow('STALE_TASK');
    document.body.append(detached,detached.cloneNode(true));expect(inspect).toThrow('STALE_TASK');
  });
  it('rejects different origin and ambiguous question selectors',()=>{
    expect(()=>taskDom(root(),{profile:{...profile,origin:'https://foreign.example'}})).toThrow('UNSUPPORTED_ORIGIN');
    root().insertAdjacentHTML('beforeend','<p id="question">Second question</p>');expect(inspect).toThrow('UNSUPPORTED_TASK');
  });
  it.each(['differentName','emptyName','disabled','duplicateValue','emptyLabel','missingChoice','outsideChoice'])('rejects ambiguous native group %s',change=>{
    const choices=root().querySelectorAll('input');
    if(change==='differentName')choices[1]!.name='second';
    if(change==='emptyName')choices[0]!.name='';
    if(change==='disabled')choices[0]!.disabled=true;
    if(change==='duplicateValue')choices[1]!.value='sky';
    if(change==='emptyLabel')choices[0]!.parentElement!.lastChild!.textContent='';
    if(change==='missingChoice')choices[1]!.remove();
    if(change==='outsideChoice'){const form=root();const inner=document.createElement('section');inner.id='task';inner.setAttribute('data-task-id','t1');inner.setAttribute('data-project-id','p1');while(form.firstChild)inner.append(form.firstChild);form.removeAttribute('id');form.append(inner);form.insertAdjacentHTML('beforeend','<input type="radio" name="other" value="extra">');}
    expect(inspect).toThrow('UNSUPPORTED_TASK');
  });
  it('supports one explicit aria group and rejects ungrouped or mixed controls',()=>{
    root().querySelector('fieldset')!.outerHTML='<div role="radiogroup"><button role="radio" aria-checked="true" data-option-id="yes">Yes</button><button role="radio" aria-checked="false" data-option-id="no">No</button></div>';
    const ariaProfile={...profile,options:'[role="radio"]'};expect(taskDom(root(),{profile:ariaProfile}).selected).toEqual(['yes']);
    root().querySelector('[role="radiogroup"]')!.removeAttribute('role');expect(()=>taskDom(root(),{profile:ariaProfile})).toThrow('UNSUPPORTED_TASK');
  });
  it('supports aria pressed buttons with generated option IDs',()=>{
    root().querySelector('fieldset')!.outerHTML='<div role="group"><button aria-pressed="false" aria-label="First"></button><button aria-pressed="true">Second</button></div>';
    const pressed={...profile,options:'button[aria-pressed]'};const value=taskDom(root(),{profile:pressed});expect(value.selected).toEqual(['option-2']);expect(value.options[0]!.label).toBe('First');
    root().querySelector('[aria-pressed]')!.setAttribute('aria-disabled','true');expect(()=>taskDom(root(),{profile:pressed})).toThrow('UNSUPPORTED_TASK');
  });
  it.each(['task','project','longTask','longQuestion','longLabel','expired','invalidExpiry'])('rejects invalid %s metadata without truncation',change=>{
    if(change==='task')root().removeAttribute('data-task-id');
    if(change==='project')root().removeAttribute('data-project-id');
    if(change==='longTask')root().setAttribute('data-task-id','x'.repeat(257));
    if(change==='longQuestion')document.querySelector('#question')!.textContent='x'.repeat(64_001);
    if(change==='longLabel')document.querySelector('label')!.append('x'.repeat(2049));
    const p={...profile,expiresAttribute:'data-expires-at'};
    if(change==='expired')root().setAttribute('data-expires-at','2000-01-01T00:00:00Z');
    if(change==='invalidExpiry')root().setAttribute('data-expires-at','tomorrow');
    expect(()=>taskDom(root(),{profile:p})).toThrow();
  });
  it('extracts future expiry and refuses an empty task',()=>{
    const expiresAt='2099-01-01T00:00:00.000Z';root().setAttribute('data-expires-at',expiresAt);expect(taskDom(root(),{profile:{...profile,expiresAttribute:'data-expires-at'}}).expiresAt).toBe(expiresAt);
    document.querySelector('#question')!.textContent='';expect(inspect).toThrow('UNSUPPORTED_TASK');
  });
  it('requires loaded image and rejects extra media',()=>{
    root().insertAdjacentHTML('beforeend','<img id="image" src="/a.png">');expect(inspect).toThrow('MEDIA_NOT_READY');
    const image=document.querySelector('#image')!;Object.defineProperties(image,{complete:{value:true},naturalWidth:{value:10},currentSrc:{value:'https://image.example/a.png'}});
    expect(inspect().imageUrl).toBe('https://image.example/a.png');root().insertAdjacentHTML('beforeend','<img src="/b.png">');expect(inspect).toThrow('UNSUPPORTED_TASK');
  });
  it('retains source audio URL and refuses missing/extra audio',()=>{
    root().insertAdjacentHTML('beforeend','<audio id="audio"><source src="/sound.wav"></audio>');expect(inspect().audioUrl).toBe(new URL('/sound.wav',location.href).href);
    root().querySelector('source')!.remove();expect(inspect).toThrow('MEDIA_NOT_READY');
    root().insertAdjacentHTML('beforeend','<audio src="/other.wav"></audio>');expect(inspect).toThrow('UNSUPPORTED_TASK');
  });
});

describe('complete instructions and click-time guards',()=>{
  it('preserves paragraphs, lists and examples in order',()=>{
    document.querySelector('#instructions')!.innerHTML='<h2>Rules</h2><p>First<br>second</p><ul><li>Example A</li><li>Example B</li></ul><script>ignored()</script><style>body{}</style>';
    const blocks=instructionDom(['#instructions']);expect(blocks[0]).toEqual({type:'text',text:expect.stringContaining('First\nsecond')});expect(JSON.stringify(blocks)).toContain('- Example A');expect(JSON.stringify(blocks)).not.toContain('ignored');
  });
  it.each(['iframe','video','canvas','object','embed'])('blocks unsupported instruction material %s',tag=>{
    document.querySelector('#instructions')!.innerHTML=`<${tag}></${tag}>`;expect(()=>instructionDom(['#instructions'])).toThrow('INSTRUCTIONS_UNSUPPORTED');
  });
  it('refuses missing instructions and unknown linked continuation',()=>{
    expect(()=>instructionDom(['#missing'])).toThrow('INSTRUCTIONS_INCOMPLETE');document.querySelector('#instructions')!.innerHTML='<a href="/more-rules">Required rules</a>';expect(()=>instructionDom(['#instructions'])).toThrow('INSTRUCTIONS_LINK_UNSUPPORTED');
  });
  it('retains linked audio/image examples and captions without fetching arbitrary HTML',()=>{
    document.querySelector('#instructions')!.innerHTML='<p>Use both examples.</p><a href="/example.mp3">Speech</a><a href="/picture.png">Image</a><a href="#footnote">Footnote</a>';
    const blocks=instructionDom(['#instructions']);expect(blocks.map(b=>b.type)).toEqual(['text','audio','image','text']);expect(blocks[1]).toEqual({type:'audio',url:new URL('/example.mp3',location.href).href,caption:'Speech'});
  });
  it('retains native audio examples and rejects media without source',()=>{
    document.querySelector('#instructions')!.innerHTML='<audio aria-label="sound example"><source src="/sound.wav"></audio>';
    expect(instructionDom(['#instructions'])[0]).toMatchObject({type:'audio',caption:'sound example'});
    document.querySelector('source')!.remove();expect(()=>instructionDom(['#instructions'])).toThrow('INSTRUCTIONS_INCOMPLETE');
  });
  it('refuses unloaded instruction images and over-limit text rather than summarizing',()=>{
    document.querySelector('#instructions')!.innerHTML='<img src="/example.png">';expect(()=>instructionDom(['#instructions'])).toThrow('MEDIA_NOT_READY');
    document.querySelector('#instructions')!.textContent='x'.repeat(64_001);expect(()=>instructionDom(['#instructions'])).toThrow('CONTEXT_TOO_LARGE');
  });
  it.each(['unchanged','instruction','task','selection','detached'])('guards the actual click against %s state',change=>{
    const expected=inspect();const button=document.querySelector('#submit')!;button.setAttribute('type','button');
    (document.querySelector('input') as HTMLInputElement).checked=true;
    const guarded=taskDom(root(),{profile,guard:{target:button,fingerprint:expected.fingerprint,instructionSelectors:profile.instructions,instructionFingerprint:JSON.stringify([document.querySelector('#instructions')!.outerHTML]),requiredSelection:'sky'}});
    if(change==='instruction')document.querySelector('#instructions')!.textContent='new rules';
    if(change==='task')root().setAttribute('data-task-id','new');
    if(change==='selection')(document.querySelector('input') as HTMLInputElement).checked=false;
    if(change==='detached'){root().id='replacement';}
    const event=new MouseEvent('click',{bubbles:true,cancelable:true});button.dispatchEvent(event);
    expect(guarded.guard?.checked).toBe(true);expect(guarded.guard?.allowed).toBe(change==='unchanged');expect(event.defaultPrevented).toBe(change!=='unchanged');guarded.guard?.dispose();
  });
});
