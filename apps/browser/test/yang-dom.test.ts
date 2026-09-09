// @vitest-environment jsdom
import { beforeEach,describe,expect,it } from 'vitest';
import { authDom,catalogueDom,instructionDom,partDom } from '../src/yang-dom.js';

beforeEach(()=>{document.body.innerHTML='';});
describe('Yang DOM contracts',()=>{
  it('requires positive authenticated UI, not merely Yang URL',()=>{
    expect(authDom()).toBe('UNKNOWN');document.body.innerHTML='<input name="login">';expect(authDom()).toBe('LOGIN_REQUIRED');
    document.body.innerHTML='<input autocomplete="one-time-code">';expect(authDom()).toBe('SECOND_FACTOR_REQUIRED');
    document.body.innerHTML='<a href="/?activeTab=all">Задания</a><a href="/?activeTab=active">В работе</a><span>Избранное</span>';expect(authDom()).toBe('CONNECTED');
  });
  it('extracts comparable reward per platform unit and pool identity, never ordinal or title',()=>{
    document.body.innerHTML='<ul><li><h3>Project</h3><span>15.00 за задание</span><a href="/instructions/94707463">Инструкция</a><button>Приступить</button></li></ul>';
    expect(catalogueDom()).toMatchObject([{poolId:'94707463',price:'15.00',unit:'за задание',available:true}]);
    document.querySelector('a')!.removeAttribute('href');expect(catalogueDom()[0]!.poolId).toBe('');
  });
  it('preserves closed details, ordered example media and required external instruction sources',()=>{
    document.body.innerHTML='<h1>Rules</h1><details><summary>Examples</summary><p>Never average overall preference.</p><audio src="/a.wav"></audio></details><a href="https://jing.yandex-team.ru/files/x/rules.html">Full rules</a><a href="https://t.me/team">Chat</a>';
    const instruction=instructionDom();expect(instruction.blocks[0]).toMatchObject({type:'text'});expect(JSON.stringify(instruction.blocks)).toContain('Never average');expect(instruction.blocks[1]).toMatchObject({type:'audio'});expect(instruction.documents).toEqual(['https://jing.yandex-team.ru/files/x/rules.html']);
  });
  it('rejects unsupported instruction media instead of silently dropping it',()=>{document.body.innerHTML='<video src="/video.mp4"></video>';expect(instructionDom).toThrow('INSTRUCTIONS_UNSUPPORTED');});
  it('scopes unnamed repeated radio values into independent questions and stable worker ids',()=>{
    document.body.innerHTML='<form><p>Compare voices</p><fieldset><legend>Sound</legend><label><input type="radio" value="same">Same</label><label><input type="radio" value="different">Different</label></fieldset><fieldset><legend>Manner</legend><label><input type="radio" value="same">Same</label><label><input type="radio" value="different">Different</label></fieldset></form>';
    const root=document.querySelector('form')!;const before=partDom(root,'part-1');expect(before.fields).toHaveLength(2);expect(before.ungrouped).toEqual([]);expect(before.fields[0]!.options[0]!.id).not.toBe(before.fields[1]!.options[0]!.id);
    (root.querySelector('input') as HTMLInputElement).checked=true;const after=partDom(root,'part-1');expect(after.fingerprint).toBe(before.fingerprint);expect(after.controls[0]!.value).toEqual([before.controls[0]!.id]);
  });
  it('extracts multi choice, text, numeric constraints and selects without treating them as unsupported',()=>{
    document.body.innerHTML='<form><fieldset><legend>Choose all</legend><label><input type="checkbox">A</label><label><input type="checkbox">B</label></fieldset><label>Why<textarea maxlength="50"></textarea></label><label>Count<input type="number" min="1" max="5" step="1" required></label><label>Pick<select><option value="a">A</option><option value="b">B</option></select></label></form>';
    const part=partDom(document.querySelector('form')!,'p');expect(part.fields.map(f=>f.kind)).toEqual(['MULTIPLE_CHOICE','TEXT','NUMBER','SINGLE_CHOICE']);expect(part.fields[2]).toMatchObject({min:1,max:5,step:1});
  });
  it('exposes opaque controls for validated mapping, rather than guessing a group',()=>{
    document.body.innerHTML='<form><p>Rate both sides</p><div><button aria-pressed="false">❌</button><button aria-pressed="false">💚</button></div><div><button aria-pressed="false">❌</button><button aria-pressed="false">💚</button></div></form>';
    const part=partDom(document.querySelector('form')!,'p');expect(part.fields).toEqual([]);expect(part.ungrouped).toHaveLength(4);
  });
  it('detects changed instruction text, rearranged materials and conditional fields through fingerprints',()=>{
    document.body.innerHTML='<form><label>Comment<textarea></textarea></label><audio src="/left.wav"></audio><audio src="/right.wav"></audio></form>';
    const root=document.querySelector('form')!;const first=partDom(root,'p');root.querySelector('audio')!.setAttribute('src','/changed.wav');expect(partDom(root,'p').fingerprint).not.toBe(first.fingerprint);
    root.insertAdjacentHTML('beforeend','<label>Conditional<input type="text"></label>');expect(partDom(root,'p').fields).toHaveLength(2);
  });
  it.each(['video','canvas','input type="file"','div contenteditable="true"'])('rejects unsupported work %s',tag=>{document.body.innerHTML=`<form><label>A<input type="text"></label><${tag}></${tag.split(' ')[0]}></form>`;expect(()=>partDom(document.querySelector('form')!,'p')).toThrow('UNSUPPORTED_TASK');});
  it('preserves ordered list numbering, tables and external HTML references written as plain text',()=>{
    document.body.innerHTML='<ol start="4"><li>First</li><li value="7">Second</li><li>Third</li></ol><ol reversed><li>A</li><li>B</li></ol><table><tr><td>X</td><th>Y</th></tr></table><p>https://jing.yandex-team.ru/files/x/rules.html</p>';
    const instruction=instructionDom();const text=instruction.blocks.filter(b=>b.type==='text').map(b=>b.text).join('');expect(text).toContain('4. First');expect(text).toContain('7. Second');expect(text).toContain('8. Third');expect(text).toContain('2. A');expect(text).toContain('\tX\tY');expect(instruction.documents).toHaveLength(1);
  });
  it('chunks a long complete source without losing characters or splitting surrogate pairs',()=>{
    const source='а'.repeat(262143)+'😀'+'б'.repeat(80_000);document.body.textContent=source;const blocks=instructionDom().blocks;expect(blocks).toHaveLength(2);expect(blocks.map(b=>b.type==='text'?b.text:'').join('')).toBe(source);
  });
  it.each(['<audio></audio>','<img>','<a href="https://foreign.example/external">Other work</a>','<iframe></iframe>'])('rejects incomplete or unsupported instruction %s',markup=>{document.body.innerHTML=markup;expect(instructionDom).toThrow();});
  it('includes linked audio/images, excludes scripts and avoids following operational links',()=>{
    document.body.innerHTML='<script>secret()</script><style>body { color: red; }</style><a href="/example.wav">Audio</a><a href="/example.png">Image</a><a href="https://forms.yandex.ru/survey">Feedback</a>';
    const parsed=instructionDom();expect(parsed.blocks.map(b=>b.type)).toEqual(['audio','image','text']);expect(JSON.stringify(parsed)).not.toContain('secret()');expect(parsed.documents).toEqual([]);
  });
  it('extracts aria choices with explicit labels and a select with multiple selected options',()=>{
    document.body.innerHTML='<form><div role="radiogroup" aria-label="Quality"><button role="radio" aria-checked="true" aria-label="Good">1</button><button role="radio" aria-checked="false" aria-label="Bad">0</button></div><span id="label">Select all</span><select aria-labelledby="label" multiple required><option value="a" selected>A</option><option value="b" selected>B</option><option disabled value="c">C</option></select></form>';
    const part=partDom(document.querySelector('form')!,'p');expect(part.fields.map(f=>f.kind)).toEqual(['SINGLE_CHOICE','MULTIPLE_CHOICE']);expect(part.fields[0]!.label).toBe('Quality');expect(part.controls[2]!.value).toHaveLength(2);expect(part.controls[2]!.required).toBe(true);
  });
  it.each(['<input type="password">','<input type="text" disabled aria-label="Disabled">','<button aria-pressed="false" aria-disabled="true">X</button>','<select aria-label="Pick"><option>Single</option></select>','<input type="text">'])('rejects unfillable or ambiguous field %s',markup=>{document.body.innerHTML=`<form>${markup}</form>`;expect(()=>partDom(document.querySelector('form')!,'p')).toThrow('UNSUPPORTED_TASK');});
  it('keeps unrelated field identities when an earlier conditional field appears',()=>{
    document.body.innerHTML='<form><label>Existing<textarea></textarea></label></form>';const root=document.querySelector('form')!;const id=partDom(root,'p').fields[0]!.id;root.insertAdjacentHTML('afterbegin','<label>New earlier<input type="text"></label>');expect(partDom(root,'p').fields[1]!.id).toBe(id);
  });
  it('ignores hidden conditional controls and rejects detached roots',()=>{document.body.innerHTML='<form><label>Present<input type="text"></label><label hidden>Later<input type="text"></label></form>';const root=document.querySelector('form')!;expect(partDom(root,'p').fields).toHaveLength(1);root.remove();expect(()=>partDom(root,'p')).toThrow('STALE_TASK');});
  it('does not expose required controls inside an ancestor hidden by CSS',()=>{document.body.innerHTML='<style>.hidden { display:none }</style><form><label>Present<input type="text"></label><div class="hidden"><label>Later<input type="text" required></label></div></form>';expect(partDom(document.querySelector('form')!,'p').fields).toHaveLength(1);});
  it('preserves source paragraphs inside fieldsets while keeping question labels in fields',()=>{document.body.innerHTML='<form><fieldset><legend>Which is correct?</legend><p>The actual source article is here.</p><label><input type="radio" name="a">A</label><label><input type="radio" name="a">B</label></fieldset></form>';const part=partDom(document.querySelector('form')!,'p');expect(part.materialText).toBe('The actual source article is here.');expect(part.fields[0]!.label).toBe('Which is correct?');});
  it('classifies observed catalogue badges, training/exam labels, unknown rewards and disabled projects',()=>{document.body.innerHTML='<ul><li><h2>Training exam</h2><p>Обучение, экзамен</p><span title="Аудио"></span><span aria-label="Картинки"></span><span title="Текст"></span><a href="/instructions/12">Инструкция</a><button disabled>Приступить</button></li></ul>';expect(catalogueDom()).toMatchObject([{poolId:'12',price:null,available:false,training:true,exam:true,modalities:['text','image','audio']}]);});
  it('detects public login and numeric OTP inputs without reading their values',()=>{document.body.innerHTML='<a href="/login">Войти</a>';expect(authDom()).toBe('LOGIN_REQUIRED');document.body.innerHTML='<input inputmode="numeric" maxlength="6">';expect(authDom()).toBe('SECOND_FACTOR_REQUIRED');});
  it('takes non-empty audio source fallback and rejects missing task media',()=>{document.body.innerHTML='<form><label>Answer<textarea></textarea></label><audio><source src="/clip.wav"></audio></form>';expect(partDom(document.querySelector('form')!,'p').media[0]!.url).toContain('/clip.wav');document.querySelector('source')!.remove();expect(()=>partDom(document.querySelector('form')!,'p')).toThrow('MEDIA_NOT_READY');});
});
