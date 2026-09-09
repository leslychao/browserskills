import { afterEach,describe,it,expect,vi } from 'vitest';
import { render,screen,fireEvent,waitFor,within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { ApiClient,ClientError } from './api';
import { browserStatus,catalogue,run,selection,user } from './test-fixtures';
vi.mock('./RemoteBrowser',()=>({RemoteBrowser:()=> <div>Экран браузера</div>}));
afterEach(()=>vi.unstubAllGlobals());

function clientMock(){
  const manualControl=vi.fn().mockResolvedValue({state:'AVAILABLE',expiresAt:null});
  return {controlId:'tab-one',manualControl,me:vi.fn().mockResolvedValue(user),browser:vi.fn().mockResolvedValue(browserStatus),catalogue:vi.fn().mockResolvedValue(catalogue),refreshCatalogue:vi.fn().mockResolvedValue(catalogue),selection:vi.fn().mockResolvedValue(selection),saveSelection:vi.fn().mockImplementation(async value=>value),runs:vi.fn().mockResolvedValue([]),run:vi.fn().mockResolvedValue(run),openBrowser:vi.fn().mockResolvedValue(browserStatus),enterManual:vi.fn().mockImplementation(async()=>{manualControl.mockResolvedValue({state:'OWNED',expiresAt:null});return {...browserStatus,mode:'MANUAL'};}),exitManual:vi.fn().mockResolvedValue(browserStatus),startRun:vi.fn().mockResolvedValue(run),resume:vi.fn().mockResolvedValue(run),stop:vi.fn().mockResolvedValue({...run,status:'STOPPED',current:null})};
}
const show=(client:ReturnType<typeof clientMock>,pollInterval=100000)=>render(<App client={client as unknown as ApiClient} pollInterval={pollInterval}/>);
const selectProject=async()=>userEvent.click(await screen.findByRole('radio',{name:'Сравнения аудио'}));
describe('autonomous Yang workspace',()=>{
  it('does not open another tab controller and requires explicit takeover',async()=>{
    const client=clientMock();client.browser.mockResolvedValue({...browserStatus,mode:'MANUAL'});
    client.manualControl.mockResolvedValue({state:'IN_USE',expiresAt:null});show(client);
    const takeover=await screen.findByRole('button',{name:'Перехватить управление'});
    expect(screen.queryByText('Экран браузера')).toBeNull();expect(client.enterManual).not.toHaveBeenCalled();
    await userEvent.click(takeover);await screen.findByText('Экран браузера');
    expect(client.enterManual).toHaveBeenCalledWith(true);
  });
  it('removes the screen after another tab takes control without reacquiring it',async()=>{
    const client=clientMock();client.browser.mockResolvedValue({...browserStatus,mode:'MANUAL'});
    client.manualControl.mockResolvedValue({state:'OWNED',expiresAt:null});show(client,30);
    await screen.findByText('Экран браузера');
    client.manualControl.mockResolvedValue({state:'IN_USE',expiresAt:null});
    await screen.findByRole('button',{name:'Перехватить управление'});
    expect(screen.queryByText('Экран браузера')).toBeNull();expect(client.enterManual).not.toHaveBeenCalled();
  });
  it('opens the shared workspace without a login form or logout action',async()=>{
    const client=clientMock();show(client);
    await screen.findByRole('heading',{name:'Яндекс Янг'});
    expect(screen.queryByLabelText('Логин')).toBeNull();
    expect(screen.queryByLabelText('Пароль')).toBeNull();
    expect(screen.queryByRole('button',{name:'Выйти'})).toBeNull();
    expect(screen.getByText('Общее пространство')).toBeTruthy();
  });
  it('connects Yang directly inside the server browser and observes OTP state without taking credentials',async()=>{
    const client=clientMock();client.browser.mockResolvedValue({...browserStatus,mode:'CLOSED',generation:null,yang:{...browserStatus.yang,state:'LOGIN_REQUIRED'}});
    client.enterManual.mockResolvedValue({...browserStatus,mode:'MANUAL',yang:{...browserStatus.yang,state:'TWO_FACTOR_REQUIRED',message:'Введите код в форме Яндекса'}});
    client.manualControl.mockResolvedValue({state:'OWNED',expiresAt:null});
    show(client);
    await userEvent.click(await screen.findByRole('button',{name:'Подключить Янг'}));
    await screen.findByText('Экран браузера');
    expect(client.openBrowser).toHaveBeenCalledTimes(1);expect(client.enterManual).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Требуется второй фактор')).toBeTruthy();
    expect(screen.queryByLabelText('Одноразовый код')).toBeNull();expect(screen.queryByLabelText('Пароль')).toBeNull();
    await userEvent.click(screen.getByRole('button',{name:'Завершить ручное управление'}));
    await screen.findByText('Янг подключён');
    expect(screen.queryByText('Экран браузера')).toBeNull();
    expect(client.startRun).not.toHaveBeenCalled();expect(client.resume).not.toHaveBeenCalled();
  });
  it('requires an explicit manual project and starts a saved selection as whole sets',async()=>{
    const client=clientMock();show(client);
    const start=await screen.findByRole('button',{name:'Запустить'});
    expect((start as HTMLButtonElement).disabled).toBe(true);
    await selectProject();fireEvent.change(screen.getByLabelText('Наборов максимум'),{target:{value:'3'}});
    await userEvent.click(start);
    expect(client.saveSelection).toHaveBeenCalledWith({...selection,poolId:'pool-1'});
    expect(client.startRun).toHaveBeenCalledWith(3,{...selection,poolId:'pool-1'});
    await screen.findByRole('heading',{name:'Первая пара'});
    expect(screen.queryByRole('button',{name:'Подтвердить и отправить'})).toBeNull();
    expect(screen.getByText('Выбран пользователем')).toBeTruthy();
    expect(screen.getByText('AI-запросов на инструкцию: 2')).toBeTruthy();
    await userEvent.click(screen.getByRole('button',{name:'Стоп'}));
    expect(client.stop).toHaveBeenCalledWith(run.id);
  });
  it('saves automatic filters and keeps local edits through status polling',async()=>{
    const client=clientMock();show(client,30);
    await userEvent.click(await screen.findByRole('radio',{name:'Автоматический выбор'}));
    await userEvent.selectOptions(screen.getByLabelText('Разрешённые проекты'),['pool-1','pool-2']);
    await userEvent.selectOptions(screen.getByLabelText('Исключённые проекты'),['pool-2']);
    fireEvent.change(screen.getByLabelText('Минимальная оплата'),{target:{value:'10.25'}});
    await userEvent.click(screen.getByLabelText('Изображения'));
    await userEvent.click(screen.getByLabelText('Включать обучение'));
    await userEvent.click(screen.getByLabelText('Включать экзамены'));
    await waitFor(()=>expect(client.browser.mock.calls.length).toBeGreaterThan(1));
    expect((screen.getByLabelText('Минимальная оплата') as HTMLInputElement).value).toBe('10.25');
    await userEvent.click(screen.getByRole('button',{name:'Сохранить настройки'}));
    expect(client.saveSelection).toHaveBeenCalledWith({...selection,mode:'AUTO',includePoolIds:['pool-1'],excludePoolIds:['pool-2'],minReward:'10.25',modalities:['text','audio'],includeTraining:true,includeExams:true});
    await screen.findByText('Настройки сохранены');
    expect(client.startRun).not.toHaveBeenCalled();
    expect(screen.getByText(/Максимальная указанная оплата/)).toBeTruthy();
  });
  it('continues the current suite only when the server observed its identity',async()=>{
    const client=clientMock();client.catalogue.mockResolvedValue({...catalogue,activePoolId:'pool-1',activeSuiteId:'suite-9'});show(client);
    await userEvent.click(await screen.findByRole('radio',{name:'Набор, открытый в серверном браузере'}));
    const start=screen.getByRole('button',{name:'Запустить'});await waitFor(()=>expect((start as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(start);expect(client.startRun).toHaveBeenCalledWith(50,selection);
  });
  it('blocks duplicate starts and invalid limits, shows quality refusals and catalogue refresh',async()=>{
    const client=clientMock();client.startRun.mockImplementation(()=>new Promise(()=>{}));show(client);
    await selectProject();
    expect(screen.getByText('Качество модели для интонации не подтверждено')).toBeTruthy();
    expect((screen.getByRole('radio',{name:'Оценка интонации'}) as HTMLInputElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button',{name:'Обновить каталог'}));expect(client.refreshCatalogue).toHaveBeenCalledTimes(1);
    const button=screen.getByRole('button',{name:'Запустить'});
    fireEvent.change(screen.getByLabelText('Наборов максимум'),{target:{value:'51'}});expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Наборов максимум'),{target:{value:'2'}});
    fireEvent.click(button);fireEvent.click(button);
    await waitFor(()=>expect(client.startRun).toHaveBeenCalledTimes(1));
  });
  it('waits for explicit resume after login and releases manual control first',async()=>{
    const client=clientMock();const paused={...run,status:'WAITING_FOR_AUTH',error:{code:'AUTH_EXPIRED',message:'Войдите в Янг снова'}};
    client.runs.mockResolvedValue([paused]);client.run.mockResolvedValue(paused);client.browser.mockResolvedValue({...browserStatus,mode:'MANUAL'});client.manualControl.mockResolvedValue({state:'OWNED',expiresAt:null});show(client);
    await screen.findByText('Войдите в Янг снова');
    expect(client.resume).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button',{name:'Продолжить'}));
    expect(client.exitManual).toHaveBeenCalledTimes(1);expect(client.resume).toHaveBeenCalledWith(run.id);
  });
  it('shows unknown whole-set results without any resubmit control and reads history',async()=>{
    const client=clientMock();const unknown={...run,status:'UNKNOWN',current:null,processed:1,error:{code:'UNCERTAIN',message:'Ответ сайта не получен'},results:[{poolId:'pool-1',suiteId:'suite-1',ordinal:1,status:'UNKNOWN',answers:null,code:'TIMEOUT',createdAt:run.createdAt}]};
    client.runs.mockResolvedValue([unknown,{...unknown,id:'20000000-0000-4000-8000-000000000002'}]);client.run.mockResolvedValue(unknown);show(client);
    await screen.findByText(/Приложение не будет повторно отправлять этот набор/);
    expect(screen.queryByRole('button',{name:'Продолжить'})).toBeNull();expect(screen.getByText('TIMEOUT')).toBeTruthy();
    await userEvent.click(within(screen.getByRole('navigation')).getAllByRole('button')[1]);
    await waitFor(()=>expect(client.run).toHaveBeenCalledWith('20000000-0000-4000-8000-000000000002'));
  });
  it('shows service errors without returning to a login screen',async()=>{
    const client=clientMock();client.enterManual.mockRejectedValueOnce(new ClientError(409,'BUSY','Браузер занят')).mockRejectedValueOnce(new ClientError(401,'EXPIRED','Сессия истекла'));show(client);
    await userEvent.click(await screen.findByRole('button',{name:'Открыть Янг'}));await screen.findByText('Браузер занят');
    await userEvent.click(screen.getByRole('button',{name:'Закрыть сообщение'}));expect(screen.queryByText('Браузер занят')).toBeNull();
    await userEvent.click(screen.getByRole('button',{name:'Открыть Янг'}));await screen.findByText('Сессия истекла');
    expect(screen.getByText('Сессия истекла')).toBeTruthy();expect(screen.getByRole('heading',{name:'Яндекс Янг'})).toBeTruthy();expect(screen.queryByLabelText('Пароль')).toBeNull();
  });
  it('shows startup connection failure without protected content',async()=>{
    const client=clientMock();client.me.mockRejectedValue(new ClientError(0,'NETWORK_ERROR','Сервер недоступен'));show(client);
    await screen.findByText('Сервер недоступен');expect(screen.queryByRole('heading',{name:'Яндекс Янг'})).toBeNull();
  });
  it('observes completed two-factor login without automatically starting or resuming a run',async()=>{
    const client=clientMock();client.browser.mockResolvedValue({...browserStatus,yang:{...browserStatus.yang,state:'TWO_FACTOR_REQUIRED'}});show(client,30);
    await selectProject();expect((screen.getByRole('button',{name:'Запустить'}) as HTMLButtonElement).disabled).toBe(true);
    client.browser.mockResolvedValue(browserStatus);
    await screen.findByText('Янг подключён');await waitFor(()=>expect((screen.getByRole('button',{name:'Запустить'}) as HTMLButtonElement).disabled).toBe(false));
    expect(client.startRun).not.toHaveBeenCalled();expect(client.resume).not.toHaveBeenCalled();
  });
  it('disables save and launch for invalid payment or an empty material filter',async()=>{
    const client=clientMock();show(client);
    await userEvent.click(await screen.findByRole('radio',{name:'Автоматический выбор'}));
    fireEvent.change(screen.getByLabelText('Минимальная оплата'),{target:{value:'-1'}});
    expect((screen.getByRole('button',{name:'Запустить'}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button',{name:'Сохранить настройки'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Минимальная оплата'),{target:{value:''}});
    await userEvent.click(screen.getByLabelText('Текст'));await userEvent.click(screen.getByLabelText('Изображения'));await userEvent.click(screen.getByLabelText('Аудио'));
    expect((screen.getByRole('button',{name:'Запустить'}) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByLabelText('Текст'));
    expect((screen.getByRole('button',{name:'Запустить'}) as HTMLButtonElement).disabled).toBe(false);
  });
  it('does not start a saved project that disappeared from the refreshed catalogue',async()=>{
    const client=clientMock();client.selection.mockResolvedValue({...selection,poolId:'missing'});show(client);
    await screen.findByText(/Выбранный проект сейчас отсутствует/);
    expect((screen.getByRole('button',{name:'Запустить'}) as HTMLButtonElement).disabled).toBe(true);
    client.refreshCatalogue.mockResolvedValue({...catalogue,items:[]});
    await userEvent.click(screen.getByRole('button',{name:'Обновить каталог'}));
    await screen.findByText('Доступных проектов пока нет. Обновите каталог позже.');
  });
});
