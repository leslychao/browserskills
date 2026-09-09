import { describe,it,expect } from 'vitest';
import { render,screen } from '@testing-library/react';
import type { TaskField } from '@browserskills/contracts';
import { TaskSetPanel } from './TaskSetPanel';
import { run,taskSet } from './test-fixtures';

describe('whole-set observation',()=>{
  it('shows every part and original media, with no editable answers or submit control',()=>{
    const fields:TaskField[]=[
      taskSet.parts[0].fields[0],
      {...taskSet.parts[0].fields[0],id:'multi',kind:'MULTI_CHOICE',label:'Несколько признаков',value:['same','different'],required:false},
      {...taskSet.parts[0].fields[0],id:'number',kind:'NUMBER',label:'Количество',options:[],value:0},
      {...taskSet.parts[0].fields[0],id:'text',kind:'TEXT',label:'Комментарий',options:[],value:'Две записи'},
      {...taskSet.parts[0].fields[0],id:'missing',label:'Пустое поле',value:null},
    ];
    const {container}=render(<TaskSetPanel task={{...taskSet,parts:[{...taskSet.parts[0],fields},{...taskSet.parts[0],id:'part-2',title:'',text:'',media:[{id:'image',kind:'image',mimeType:'image/png',byteLength:128,sha256:'e'.repeat(64)}],fields:[],unmappedControls:[{id:'button',label:'Да',context:'Сравнение',selected:null}]}]}} runId={run.id}/>);
    expect(screen.getByRole('region',{name:'Часть 1'})).toBeTruthy();expect(screen.getByRole('region',{name:'Часть 2'})).toBeTruthy();
    expect(screen.getByText('Похожи, Не похожи')).toBeTruthy();expect(screen.getByText('0')).toBeTruthy();expect(screen.getByText('Две записи')).toBeTruthy();expect(screen.getByText('Не заполнено')).toBeTruthy();
    expect(screen.getByText(/Отправка пока недоступна/)).toBeTruthy();expect(screen.getByAltText('Изображение 1')).toBeTruthy();
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(`/api/runs/${run.id}/media/audio-1`);
    expect(container.querySelector('input,textarea,button')).toBeNull();
  });
  it('shows empty optional multi-selection as unfilled without manufacturing an answer',()=>{
    render(<TaskSetPanel task={{...taskSet,parts:[{...taskSet.parts[0],fields:[{...taskSet.parts[0].fields[0],kind:'MULTI_CHOICE',required:false,value:[]}]}]}} runId={run.id}/>);
    expect(screen.getByText('Не заполнено')).toBeTruthy();
  });
});
