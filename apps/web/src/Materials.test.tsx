import { describe,it,expect } from 'vitest';
import { fireEvent,render,screen } from '@testing-library/react';
import { Instructions,Media } from './Materials';

const audio={id:'audio-1',kind:'audio' as const,mimeType:'audio/wav',byteLength:64000,sha256:'a'.repeat(64),durationMs:2000};
const image={id:'image-1',kind:'image' as const,mimeType:'image/png',byteLength:128,sha256:'b'.repeat(64)};
describe('original materials for observing a run',()=>{
  it('shows complete instruction text and every example with scoped original media URLs',()=>{
    const {container}=render(<Instructions instruction={{sourceKey:'pool/instruction',hash:'c'.repeat(64),blocks:[{id:'rule',type:'text',text:'Полное правило\nИсключение из правила'},{id:'audio',type:'audio',asset:audio,caption:'Голос один'},{id:'image',type:'image',asset:image,caption:'Пример изображения'}]}} runId="run/1"/>);
    expect(screen.getByRole('region',{name:'Полная инструкция'}).textContent).toContain('Исключение из правила');
    expect(container.querySelector('audio')?.getAttribute('src')).toBe('/api/runs/run%2F1/media/audio-1');
    expect(screen.getByText('2 сек.')).toBeTruthy();
    expect(screen.getByAltText('Пример изображения')).toBeTruthy();
  });
  it('makes missing media explicit and recovers only for a different asset',()=>{
    const {container,rerender}=render(<Media asset={audio} runId="run"/>);
    fireEvent.error(container.querySelector('audio')!);
    expect(screen.getByRole('alert').textContent).toContain('Материал не загрузился');
    rerender(<Media asset={{...audio,id:'audio-2'}} runId="run"/>);
    expect(container.querySelector('audio')?.getAttribute('src')).toContain('audio-2');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('uses meaningful default labels for uncaptioned media',()=>{
    const {rerender}=render(<Media asset={{...audio,durationMs:undefined}} runId="run"/>);
    expect(screen.getByLabelText('Аудиозапись задания')).toBeTruthy();
    rerender(<Media asset={image} runId="run"/>);
    expect(screen.getByAltText('Изображение задания')).toBeTruthy();
    fireEvent.error(screen.getByAltText('Изображение задания'));
    expect(screen.getByRole('alert').textContent).toContain('Материал не загрузился');
  });
});
