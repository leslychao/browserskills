import { describe,it,expect,vi } from 'vitest';
import { render,screen,fireEvent,waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewPanel } from './ReviewPanel';
import { reviewTask,run } from './test-fixtures';

describe('review before any submission',()=>{
  it('renders the full instruction, original audio and model proposal without submitting',()=>{
    const submit=vi.fn();
    const {container}=render(<ReviewPanel task={reviewTask} runId={run.id} onConfirm={submit} busy={false} />);
    expect(screen.getByText(/Не учитывайте речь человека/)).toBeTruthy();
    expect((screen.getByLabelText('Сирена') as HTMLInputElement).checked).toBe(true);
    expect(container.querySelector('audio')?.src).toContain(`/api/runs/${run.id}/media/audio-1`);
    expect(submit).not.toHaveBeenCalled();
  });
  it('binds manual answer to the exact instruction and rejects double clicks locally',async()=>{
    const submit=vi.fn(()=>new Promise<void>(()=>{}));
    render(<ReviewPanel task={reviewTask} runId={run.id} onConfirm={submit} busy={false} />);
    await userEvent.click(screen.getByLabelText('Речь'));
    const button=screen.getByRole('button',{name:'Подтвердить и отправить'});
    fireEvent.click(button);fireEvent.click(button);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('speech');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
  it('clears an old selection when the instruction changes and new model abstains',async()=>{
    const props={runId:run.id,onConfirm:vi.fn().mockResolvedValue(undefined),busy:false};
    const {rerender}=render(<ReviewPanel {...props} task={reviewTask}/>);
    const task={...reviewTask,proposal:{decision:'ABSTAIN' as const},instruction:{...reviewTask.instruction,hash:'d'.repeat(64)},confirmationNonce:'nonce-2'};
    rerender(<ReviewPanel {...props} task={task}/>);
    await waitFor(()=>expect((screen.getByLabelText('Сирена') as HTMLInputElement).checked).toBe(false));
    expect((screen.getByRole('button',{name:'Подтвердить и отправить'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('keeps manual choice available on model failure and shows instruction examples',async()=>{
    const task={...reviewTask,proposal:null,aiError:{code:'MODEL_UNAVAILABLE',message:'Модель недоступна'},image:{id:'picture',kind:'image' as const,mimeType:'image/png',byteLength:128,sha256:'e'.repeat(64)},
      instruction:{...reviewTask.instruction,blocks:[...reviewTask.instruction.blocks,{type:'image' as const,asset:{id:'example',kind:'image' as const,mimeType:'image/png',byteLength:128,sha256:'f'.repeat(64)},caption:'Пример сигнала'},{type:'audio' as const,asset:reviewTask.audio!,caption:'Пример записи'}]}};
    const submit=vi.fn().mockResolvedValue(undefined);
    render(<ReviewPanel task={task} runId={run.id} onConfirm={submit} busy={false}/>);
    expect(screen.getByText('Модель недоступна')).toBeTruthy();
    expect(screen.getByAltText('Пример сигнала')).toBeTruthy();
    await userEvent.click(screen.getByLabelText('Речь'));
    await userEvent.click(screen.getByRole('button',{name:'Подтвердить и отправить'}));
    expect(submit).toHaveBeenCalledWith('speech');
  });
  it('does not submit an expired task or retry after an uncertain response',async()=>{
    const submit=vi.fn().mockRejectedValue(new Error('connection lost'));
    const {rerender}=render(<ReviewPanel task={{...reviewTask,expiresAt:'2020-01-01T00:00:00Z'}} runId={run.id} onConfirm={submit} busy={false}/>);
    expect(screen.getByRole('alert').textContent).toContain('Время задания истекло');
    expect((screen.getByRole('button',{name:'Подтвердить и отправить'}) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ReviewPanel task={reviewTask} runId={run.id} onConfirm={submit} busy={false}/>);
    await userEvent.click(screen.getByRole('button',{name:'Подтвердить и отправить'}));
    await waitFor(()=>expect(screen.getByText(/Проверяем результат отправки/)).toBeTruthy());
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('blocks confirmation when an instruction or task material cannot load',async()=>{
    const submit=vi.fn();
    const {container}=render(<ReviewPanel task={reviewTask} runId={run.id} onConfirm={submit} busy={false}/>);
    fireEvent.error(container.querySelector('audio')!);
    expect(screen.getByRole('alert').textContent).toContain('Материал не загрузился');
    expect((screen.getByRole('button',{name:'Подтвердить и отправить'}) as HTMLButtonElement).disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
});
