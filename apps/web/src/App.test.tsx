import { afterEach,describe,it,expect,vi } from 'vitest';
import { render,screen,fireEvent,waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { ApiClient,ClientError } from './api';
import { browserStatus,run,user } from './test-fixtures';
vi.mock('./RemoteBrowser',()=>({RemoteBrowser:()=> <div>Экран браузера</div>}));
afterEach(()=>vi.unstubAllGlobals());

function clientMock(){
  return {me:vi.fn().mockResolvedValue(user),browser:vi.fn().mockResolvedValue(browserStatus),runs:vi.fn().mockResolvedValue([]),run:vi.fn().mockResolvedValue(run),login:vi.fn().mockResolvedValue({id:user.id,login:user.login}),logout:vi.fn().mockResolvedValue(undefined),openBrowser:vi.fn().mockResolvedValue(browserStatus),enterManual:vi.fn().mockResolvedValue({...browserStatus,mode:'MANUAL'}),exitManual:vi.fn().mockResolvedValue(browserStatus),startRun:vi.fn().mockResolvedValue(run),confirm:vi.fn().mockResolvedValue({...run,status:'SUBMITTING'}),stop:vi.fn().mockResolvedValue({...run,status:'STOPPED',current:null})};
}
const show=(client:ReturnType<typeof clientMock>,pollInterval=100000)=>render(<App client={client as unknown as ApiClient} pollInterval={pollInterval}/>);
describe('workspace behavior',()=>{
  it('logs in with app credentials, refreshes CSRF server session through the client, and logs out',async()=>{
    const client=clientMock();client.me.mockRejectedValueOnce(new ClientError(401,'AUTH_REQUIRED','Войдите'));
    show(client);
    await screen.findByRole('heading',{name:'Войти в BrowserSkills'});
    await userEvent.type(screen.getByLabelText('Логин'),'tester');
    await userEvent.type(screen.getByLabelText('Пароль'),'password');
    await userEvent.click(screen.getByRole('button',{name:'Войти'}));
    await screen.findByRole('heading',{name:'Яндекс Янг'});
    expect(client.login).toHaveBeenCalledWith('tester','password');
    await userEvent.click(screen.getByRole('button',{name:'Выйти'}));
    await screen.findByRole('heading',{name:'Войти в BrowserSkills'});
    expect(client.logout).toHaveBeenCalledTimes(1);
  });
  it('opens and controls its own browser before starting the current task',async()=>{
    const client=clientMock();client.browser.mockResolvedValue({...browserStatus,mode:'CLOSED',generation:null});
    show(client);
    await userEvent.click(await screen.findByRole('button',{name:'Открыть браузер'}));
    await userEvent.click(await screen.findByRole('button',{name:'Открыть Яндекс'}));
    await screen.findByText('Экран браузера');
    await userEvent.click(screen.getByRole('button',{name:'Завершить ручное управление'}));
    await waitFor(()=>expect(screen.queryByText('Экран браузера')).toBeNull());
    fireEvent.change(screen.getByLabelText('Заданий максимум'),{target:{value:'3'}});
    await userEvent.click(screen.getByRole('button',{name:'Начать'}));
    await screen.findByRole('heading',{name:'Какой звук слышен на фоне?'});
    expect(client.startRun).toHaveBeenCalledWith(3);
  });
  it('confirms only after click with the exact current task, instruction and nonce; allows stopping',async()=>{
    vi.stubGlobal('crypto',{getRandomValues:crypto.getRandomValues.bind(crypto)});
    const client=clientMock();client.runs.mockResolvedValue([run]);
    show(client);
    await screen.findByRole('heading',{name:'Какой звук слышен на фоне?'});
    expect(client.confirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByLabelText('Речь'));
    await userEvent.click(screen.getByRole('button',{name:'Подтвердить и отправить'}));
    expect(client.confirm).toHaveBeenCalledWith(run.id,expect.objectContaining({taskId:'task-1',optionId:'speech',instructionHash:'a'.repeat(64),snapshotHash:'b'.repeat(64),confirmationNonce:'nonce-1'}));
    await userEvent.click(screen.getByRole('button',{name:'Стоп'}));
    expect(client.stop).toHaveBeenCalledWith(run.id);
  });
  it('prevents duplicate start while a request is pending and rejects invalid limits',async()=>{
    const client=clientMock();client.startRun.mockImplementation(()=>new Promise(()=>{}));
    show(client);
    const button=await screen.findByRole('button',{name:'Начать'});
    await waitFor(()=>expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Заданий максимум'),{target:{value:'51'}});
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Заданий максимум'),{target:{value:'2'}});
    fireEvent.click(button);fireEvent.click(button);
    expect(client.startRun).toHaveBeenCalledTimes(1);
  });
  it('shows unknown results without any resubmit control and can inspect history',async()=>{
    const client=clientMock();const unknown={...run,status:'UNKNOWN',current:null,processed:1,error:{code:'UNCERTAIN',message:'Ответ сайта не получен'},results:[{taskId:'t1',ordinal:1,status:'UNKNOWN',optionId:'siren',code:'TIMEOUT',createdAt:run.createdAt}]};
    client.runs.mockResolvedValue([unknown]);client.run.mockResolvedValue(unknown);
    show(client);
    await screen.findByText('Приложение не будет повторно отправлять это задание.',{exact:false});
    expect(screen.queryByRole('button',{name:'Подтвердить и отправить'})).toBeNull();
    expect(screen.getByText('TIMEOUT')).toBeTruthy();
    await userEvent.click(screen.getByRole('navigation').querySelector('button')!);
    await screen.findByText('Приложение не будет повторно отправлять это задание.',{exact:false});
  });
  it('clears all protected content on expired session and displays action failures',async()=>{
    const client=clientMock();client.enterManual.mockRejectedValueOnce(new ClientError(409,'BUSY','Браузер занят')).mockRejectedValueOnce(new ClientError(401,'EXPIRED','Сессия истекла'));
    show(client);
    await userEvent.click(await screen.findByRole('button',{name:'Открыть Яндекс'}));
    await screen.findByText('Браузер занят');
    await userEvent.click(screen.getByRole('button',{name:'Закрыть сообщение'}));
    expect(screen.queryByText('Браузер занят')).toBeNull();
    await userEvent.click(screen.getByRole('button',{name:'Открыть Яндекс'}));
    await screen.findByRole('heading',{name:'Войти в BrowserSkills'});
    expect(screen.getByText('Сессия истекла')).toBeTruthy();
  });
  it('shows startup connection failure without revealing protected content',async()=>{
    const client=clientMock();client.me.mockRejectedValue(new ClientError(0,'NETWORK_ERROR','Сервер недоступен'));
    show(client);
    await screen.findByText('Сервер недоступен');
    expect(screen.queryByRole('heading',{name:'Яндекс Янг'})).toBeNull();
  });
});
