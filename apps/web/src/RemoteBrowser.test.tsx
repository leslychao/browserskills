import { describe,it,expect,vi,afterEach } from 'vitest';
import { render,screen,act,fireEvent } from '@testing-library/react';
const { instances }=vi.hoisted(()=>({instances:[] as Array<EventTarget&{
  disconnect:ReturnType<typeof vi.fn>;clipboardPasteFrom:ReturnType<typeof vi.fn>;
  sendKey:ReturnType<typeof vi.fn>;focus:ReturnType<typeof vi.fn>;scaleViewport:boolean;
}>}));
vi.mock('@novnc/novnc',()=>({default:class extends EventTarget{
  disconnect=vi.fn();clipboardPasteFrom=vi.fn();sendKey=vi.fn();focus=vi.fn();
  scaleViewport=false;resizeSession=true;viewOnly=true;clipViewport=true;
  constructor(public target:HTMLElement,public url:string){super();instances.push(this);}
}}));
import { RemoteBrowser } from './RemoteBrowser';
const current=()=>instances.at(-1)!;
const connected=()=>{const view=render(<RemoteBrowser generation="a" controlId="control-a" onReconnect={()=>{}} reconnecting={false}/>);act(()=>current().dispatchEvent(new Event('connect')));return view;};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('remote browser lifecycle',()=>{
  it('offers explicit reconnect after transport loss and disables it while acquiring control',()=>{
    const reconnect=vi.fn();const props={generation:'a',controlId:'control-a',onReconnect:reconnect};
    const {rerender}=render(<RemoteBrowser {...props} reconnecting={false}/>);
    act(()=>current().dispatchEvent(new Event('disconnect')));
    fireEvent.click(screen.getByRole('button',{name:'Переподключиться'}));expect(reconnect).toHaveBeenCalledOnce();
    rerender(<RemoteBrowser {...props} reconnecting/>);
    expect((screen.getByRole('button',{name:'Переподключиться'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('connects to same-origin view and disconnects when generation changes or panel closes',()=>{
    const {rerender,unmount}=render(<RemoteBrowser generation="a" controlId="control-a" onReconnect={()=>{}} reconnecting={false}/>);
    const first=instances.at(-1)!;
    expect(screen.getByText('Подключение к браузеру')).toBeTruthy();
    act(()=>first.dispatchEvent(new Event('connect')));
    expect(screen.getByText('Ручное управление')).toBeTruthy();
    act(()=>first.dispatchEvent(new Event('securityfailure')));
    expect(screen.getByRole('alert').textContent).toContain('Соединение с экраном браузера прервано');
    rerender(<RemoteBrowser generation="b" controlId="control-b" onReconnect={()=>{}} reconnecting={false}/>);
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    const second=instances.at(-1)!;
    unmount();expect(second.disconnect).toHaveBeenCalledTimes(1);
  });
  it('changes scale without reconnecting and expands to the window when fullscreen is unavailable',()=>{
    connected();const rfb=current();const count=instances.length;
    fireEvent.change(screen.getByLabelText('Масштаб браузера'),{target:{value:'actual'}});expect(rfb.scaleViewport).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'На весь экран'}));expect(screen.getByRole('region').className).toContain('expanded');
    fireEvent.keyDown(document,{key:'Escape'});expect(screen.getByRole('region').className).not.toContain('expanded');
    fireEvent.click(screen.getByRole('button',{name:'На весь экран'}));fireEvent.click(screen.getByRole('button',{name:'Свернуть'}));
    fireEvent.change(screen.getByLabelText('Масштаб браузера'),{target:{value:'fit'}});expect(rfb.scaleViewport).toBe(true);expect(instances.length).toBe(count);
  });
  it('uses native fullscreen and restores the panel after the browser exits fullscreen',async()=>{
    connected();const region=screen.getByRole('region');
    const enter=vi.fn(async()=>{Object.defineProperty(document,'fullscreenElement',{configurable:true,value:region});document.dispatchEvent(new Event('fullscreenchange'));});
    Object.defineProperty(region,'requestFullscreen',{configurable:true,value:enter});
    const exit=vi.fn(async()=>{Object.defineProperty(document,'fullscreenElement',{configurable:true,value:null});document.dispatchEvent(new Event('fullscreenchange'));});
    Object.defineProperty(document,'exitFullscreen',{configurable:true,value:exit});
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'На весь экран'})));expect(enter).toHaveBeenCalledOnce();
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Свернуть'})));expect(exit).toHaveBeenCalledOnce();expect(region.className).not.toContain('expanded');
  });
  it('keeps window expansion if the host denies native fullscreen',async()=>{
    connected();Object.defineProperty(screen.getByRole('region'),'requestFullscreen',{value:vi.fn().mockRejectedValue(new Error('denied'))});
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'На весь экран'})));expect(screen.getByRole('region').className).toContain('expanded');
  });
  it('sends multiline text only on an explicit paste, then clears the local draft',()=>{
    connected();fireEvent.click(screen.getByRole('button',{name:'Буфер обмена'}));
    const input=screen.getByLabelText('Текст для Янг');const text='Привет, Янг 👋\nВторая строка';
    fireEvent.change(input,{target:{value:text}});expect(current().clipboardPasteFrom).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Вставить в Янг'}));expect(current().clipboardPasteFrom).toHaveBeenCalledWith(text);
    expect(current().sendKey.mock.calls).toEqual([[0xffe3,'ControlLeft',true],[0x76,'KeyV',true],[0x76,'KeyV',false],[0xffe3,'ControlLeft',false]]);
    expect((input as HTMLTextAreaElement).value).toBe('');expect(current().focus).toHaveBeenCalled();
  });
  it('captures a native host paste on the canvas without reading the system clipboard',()=>{
    const {container}=connected();const canvas=document.createElement('canvas');container.querySelector('.remote-screen')!.append(canvas);
    fireEvent.keyDown(canvas,{key:'м',code:'KeyV',ctrlKey:true});const sink=container.querySelector<HTMLTextAreaElement>('.remote-paste-target')!;expect(document.activeElement).toBe(sink);
    fireEvent.paste(sink,{clipboardData:{getData:()=> 'Вставка 👋'}});expect(current().clipboardPasteFrom).toHaveBeenCalledWith('Вставка 👋');
    current().clipboardPasteFrom.mockClear();fireEvent.paste(canvas,{clipboardData:{getData:()=> 'Ещё текст'}});expect(current().clipboardPasteFrom).toHaveBeenCalledWith('Ещё текст');
  });
  it('receives remote copy and copies to the host on HTTP using an explicit button',()=>{
    connected();act(()=>current().dispatchEvent(new CustomEvent('clipboard',{detail:{text:'Из Янг\nКириллица 👋'}})));
    fireEvent.click(screen.getByRole('button',{name:'Буфер обмена'}));const output=screen.getByLabelText('Текст из Янг') as HTMLTextAreaElement;
    expect(output.value).toBe('Из Янг\nКириллица 👋');
    const copy=vi.fn(()=>true);Object.defineProperty(document,'execCommand',{configurable:true,value:copy});
    fireEvent.click(screen.getByRole('button',{name:'Скопировать на компьютер'}));expect(copy).toHaveBeenCalledWith('copy');expect(output.selectionEnd).toBe(output.value.length);
    expect(screen.getByRole('status').textContent).toContain('Скопировано');
  });
  it('releases modifiers and restores keyboard focus after an empty or rejected host paste',()=>{
    const {container}=connected();const canvas=document.createElement('canvas');container.querySelector('.remote-screen')!.append(canvas);
    const sink=container.querySelector<HTMLTextAreaElement>('.remote-paste-target')!;
    fireEvent.keyDown(canvas,{key:'Insert',shiftKey:true});expect(current().sendKey).toHaveBeenCalledWith(0xffe1,'ShiftLeft',false);
    fireEvent.paste(sink,{clipboardData:{getData:()=>''}});expect(current().clipboardPasteFrom).not.toHaveBeenCalled();expect(current().focus).toHaveBeenCalled();
    current().focus.mockClear();fireEvent.keyDown(canvas,{key:'v',ctrlKey:true});expect(current().sendKey).toHaveBeenCalledWith(0xffe4,'ControlRight',false);
    fireEvent.paste(sink,{clipboardData:{getData:()=>'я'.repeat(33000)}});expect(current().clipboardPasteFrom).not.toHaveBeenCalled();expect(current().focus).toHaveBeenCalled();
    current().focus.mockClear();fireEvent.keyUp(sink,{key:'v'});expect(current().focus).toHaveBeenCalled();
  });
  it('selects remote text for native Ctrl+C when the host denies the copy command',()=>{
    connected();act(()=>current().dispatchEvent(new CustomEvent('clipboard',{detail:{text:'text'}})));fireEvent.click(screen.getByRole('button',{name:'Буфер обмена'}));
    Object.defineProperty(document,'execCommand',{configurable:true,value:()=>false});fireEvent.click(screen.getByRole('button',{name:'Скопировать на компьютер'}));
    expect(screen.getByRole('status').textContent).toContain('Ctrl+C');
    Object.defineProperty(document,'execCommand',{configurable:true,value:()=>{throw new Error('denied');}});fireEvent.click(screen.getByRole('button',{name:'Скопировать на компьютер'}));
    expect(screen.getByRole('status').textContent).toContain('Ctrl+C');
  });
  it('bounds clipboard text and clears it when control is disconnected',()=>{
    connected();fireEvent.click(screen.getByRole('button',{name:'Буфер обмена'}));
    fireEvent.change(screen.getByLabelText('Текст для Янг'),{target:{value:'я'.repeat(33000)}});fireEvent.click(screen.getByRole('button',{name:'Вставить в Янг'}));
    expect(current().clipboardPasteFrom).not.toHaveBeenCalled();expect(screen.getByRole('status').textContent).toContain('64 КиБ');
    act(()=>current().dispatchEvent(new CustomEvent('clipboard',{detail:{text:'🙂'.repeat(20000)}})));expect((screen.getByLabelText('Текст из Янг') as HTMLTextAreaElement).value).toBe('');
    act(()=>current().dispatchEvent(new CustomEvent('clipboard',{detail:{text:'private text'}})));
    act(()=>current().dispatchEvent(new Event('disconnect')));expect((screen.getByLabelText('Текст из Янг') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText('Текст для Янг') as HTMLTextAreaElement).value).toBe('');expect((screen.getByRole('button',{name:'Вставить в Янг'}) as HTMLButtonElement).disabled).toBe(true);
  });
});
