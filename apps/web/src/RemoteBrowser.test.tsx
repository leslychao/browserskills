import { describe,it,expect,vi } from 'vitest';
import { render,screen,act } from '@testing-library/react';
const { instances }=vi.hoisted(()=>({instances:[] as Array<EventTarget&{disconnect:ReturnType<typeof vi.fn>}>}));
vi.mock('@novnc/novnc',()=>({default:class extends EventTarget{
  disconnect=vi.fn();scaleViewport=false;resizeSession=true;viewOnly=true;
  constructor(public target:HTMLElement,public url:string){super();instances.push(this);}
}}));
import { RemoteBrowser } from './RemoteBrowser';
describe('remote browser lifecycle',()=>{
  it('connects to same-origin view and disconnects when generation changes or panel closes',()=>{
    const {rerender,unmount}=render(<RemoteBrowser generation="a"/>);
    const first=instances.at(-1)!;
    expect(screen.getByText('Подключение к браузеру')).toBeTruthy();
    act(()=>first.dispatchEvent(new Event('connect')));
    expect(screen.getByText('Ручное управление')).toBeTruthy();
    act(()=>first.dispatchEvent(new Event('securityfailure')));
    expect(screen.getByRole('alert').textContent).toContain('Соединение с браузером закрыто');
    rerender(<RemoteBrowser generation="b"/>);
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    const second=instances.at(-1)!;
    unmount();expect(second.disconnect).toHaveBeenCalledTimes(1);
  });
});
