import { useCallback,useEffect,useRef,useState } from 'react';
import { SelectionSettingsSchema } from '@browserskills/contracts';
import type { BrowserStatus,Catalogue,Me,RunSummary,RunView,SelectionSettings,YangSession } from '@browserskills/contracts';
import { ApiClient } from './api';
import { RemoteBrowser } from './RemoteBrowser';
import { SelectionPanel } from './SelectionPanel';
import { TaskSetPanel } from './TaskSetPanel';

const defaultClient=new ApiClient();
export const activeStatuses=new Set(['SELECTING','PREPARING','ANALYZING','FILLING','WAITING_FOR_AUTH','WAITING_FOR_USER','SUBMITTING']);
const pausedStatuses=new Set(['WAITING_FOR_AUTH','WAITING_FOR_USER']);
export const statusLabels:Record<RunView['status'],string>={SELECTING:'Выбираем проект',PREPARING:'Готовим инструкцию',ANALYZING:'Анализируем набор',FILLING:'Заполняем и проверяем форму',WAITING_FOR_AUTH:'Ожидаем вход в Янг',WAITING_FOR_USER:'Нужно ваше действие',SUBMITTING:'Проверяем отправку',COMPLETED:'Завершён',STOPPED:'Остановлен',INTERRUPTED:'Прерван',UNKNOWN:'Результат неизвестен',FAILED:'Ошибка'};
const authLabels:Record<YangSession['state'],string>={LOGIN_REQUIRED:'Требуется вход в Янг',TWO_FACTOR_REQUIRED:'Требуется второй фактор',READY:'Янг подключён',AUTH_EXPIRED:'Сессия Янг истекла',UNKNOWN:'Проверяем подключение Янг'};
const runMessages:Partial<Record<RunView['status'],string>>={SELECTING:'Обновляем каталог и выбираем подходящий проект.',PREPARING:'Читаем разделы инструкции и обрабатываем все примеры.',ANALYZING:'Анализируем материалы локальной моделью. Набор ещё не отправлен.',FILLING:'Сверяем ответы, обязательные и условные поля во всех частях набора.',WAITING_FOR_AUTH:'Откройте Янг, завершите вход и нажмите «Продолжить».',WAITING_FOR_USER:'Устраните указанную причину остановки. Продолжение повторно проверит набор.',SUBMITTING:'Ожидаем подтверждение Янг. Повторная отправка недоступна.'};
const resultLabels={DRAFT:'Подготовлено',SUBMIT_INTENT:'Отправка начата',SUBMITTED:'Отправлено',UNKNOWN:'Результат неизвестен',FAILED:'Ошибка'};
const time=(value:string)=>new Intl.DateTimeFormat('ru',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(value));

export function App({client=defaultClient,pollInterval=1000}:{client?:ApiClient;pollInterval?:number}) {
  const [me,setMe]=useState<Me|null>(null);
  const [initial,setInitial]=useState(true);
  const [browser,setBrowser]=useState<BrowserStatus|null>(null);
  const [control,setControl]=useState<Awaited<ReturnType<ApiClient['manualControl']>>|null>(null);
  const [connection,setConnection]=useState(0);
  const [connectingScreen,setConnectingScreen]=useState(false);
  const [catalogue,setCatalogue]=useState<Catalogue|null>(null);
  const [selection,setSelection]=useState<SelectionSettings|null>(null);
  const [saved,setSaved]=useState(false);
  const [runs,setRuns]=useState<RunSummary[]>([]);
  const [runId,setRunId]=useState<string|null>(null);
  const [view,setView]=useState<RunView|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [pending,setPending]=useState(false);
  const [limit,setLimit]=useState(50);
  const inFlight=useRef(false);
  const revision=useRef(0);
  const handleError=useCallback((cause:unknown)=>{
    setError(cause instanceof Error?cause.message:'Не удалось выполнить действие. Проверьте состояние сервера.');
  },[]);
  useEffect(()=>{
    let disposed=false;
    client.me().then(value=>{if(!disposed)setMe(value);}).catch(cause=>{if(!disposed)handleError(cause);}).finally(()=>{if(!disposed)setInitial(false);});
    return()=>{disposed=true;};
  },[client,handleError]);
  useEffect(()=>{
    if(!me)return;
    let disposed=false;
    client.selection().then(value=>{if(!disposed)setSelection(value);}).catch(cause=>{if(!disposed)handleError(cause);});
    return()=>{disposed=true;};
  },[me?.id,client,handleError]);
  const act=async(action:()=>Promise<void>)=>{
    if(inFlight.current)return;
    inFlight.current=true;revision.current++;setPending(true);setError(null);
    try{await action();}catch(cause){handleError(cause);}finally{revision.current++;inFlight.current=false;setPending(false);}
  };
  useEffect(()=>{
    if(!me)return;
    let disposed=false;let polling=false;
    const poll=async()=>{
      if(inFlight.current||polling)return;
      polling=true;const currentRevision=revision.current;
      try{
        const [identity,status,list,projects,ownership]=await Promise.all([client.me(),client.browser(),client.runs(),client.catalogue(),client.manualControl()]);
        if(disposed||currentRevision!==revision.current)return;
        setMe(identity);setBrowser(status);setRuns(list);setCatalogue(projects);setControl(ownership);
        const selected=runId??list.find(run=>activeStatuses.has(run.status))?.id??list[0]?.id;
        if(selected){
          const value=await client.run(selected);
          if(disposed||currentRevision!==revision.current)return;
          setView(value);if(runId===null)setRunId(selected);
        }
      }catch(cause){if(!disposed&&currentRevision===revision.current)handleError(cause);}
      finally{polling=false;}
    };
    void poll();const timer=setInterval(()=>void poll(),pollInterval);
    return()=>{disposed=true;clearInterval(timer);};
  },[me?.id,client,runId,pollInterval,handleError]);
  if(initial)return <main className="loading" role="status">Открываем рабочее пространство…</main>;
  if(!me)return <main className="loading"><p role="alert">{error??'Не удалось открыть рабочее пространство.'}</p><button onClick={()=>window.location.reload()}>Повторить подключение</button></main>;

  const activeRun=runs.find(run=>activeStatuses.has(run.status))??(view&&activeStatuses.has(view.status)?view:null);
  const active=activeRun!==null;
  const paused=activeRun!==null&&pausedStatuses.has(activeRun.status);
  const manual=browser?.mode==='MANUAL'&&control?.state==='OWNED';
  const controlInUse=browser?.mode==='MANUAL'&&control?.state==='IN_USE';
  const ready=browser?.yang.state==='READY'&&browser.mode!=='CLOSED';
  const validSelection=SelectionSettingsSchema.safeParse(selection).success;
  const chosen=selection?.poolId?catalogue?.items.find(item=>item.poolId===selection.poolId):null;
  const manualTarget=selection?.poolId?chosen&&chosen.availability!=='UNAVAILABLE'&&chosen.preparation!=='BLOCKED':catalogue?.activeSuiteId;
  const canStart=ready&&!active&&validSelection&&Number.isInteger(limit)&&limit>=1&&limit<=50&&(selection?.mode==='AUTO'||Boolean(manualTarget));
  const updateView=(value:RunView)=>{setView(value);setRunId(value.id);setRuns(previous=>[value,...previous.filter(item=>item.id!==value.id)]);};
  const connect=(takeOver=false)=>act(async()=>{
    setConnectingScreen(true);
    try{
      const current=await client.browser();
      if(current.mode==='CLOSED')setBrowser(await client.openBrowser());
      setBrowser(await client.enterManual(takeOver));
      setControl(await client.manualControl());setConnection(value=>value+1);
    }finally{setConnectingScreen(false);}
  });
  const save=()=>act(async()=>{if(!selection)return;setSelection(await client.saveSelection(selection));setSaved(true);});
  const start=()=>act(async()=>{
    if(!selection||!canStart)return;
    const savedSelection=await client.saveSelection(selection);setSelection(savedSelection);setSaved(true);
    if(manual)setBrowser(await client.exitManual());
    updateView(await client.startRun(limit,savedSelection));setBrowser(await client.browser());
  });
  return <div className="workspace">
    <aside className="sidebar"><a className="brand" href="/" aria-label="BrowserSkills"><span className="brand-mark">b.</span> BrowserSkills</a><div className="sidebar-context">Яндекс Янг<span>Рабочее пространство</span></div>
      <div className="sidebar-heading">Запуски <span>{runs.length}</span></div>
      <nav aria-label="История запусков" className="history">{runs.length===0?<p>История появится после первого запуска.</p>:runs.map(run=><button key={run.id} className={run.id===view?.id?'current':''} onClick={()=>{if(run.id!==runId){revision.current++;setRunId(run.id);setView(null);}}} disabled={pending}><span>{time(run.createdAt)}</span><small>{statusLabels[run.status]} · {run.processed}/{run.maxTasks}</small></button>)}</nav>
      <div className="account"><span className="avatar">Я</span><div><strong>Общее пространство</strong><small>Без входа в приложение</small></div></div>
    </aside>
    <main className="main"><header className="page-heading"><div><span className="eyebrow">Ваш помощник</span><h1>Яндекс Янг</h1><p>Выберите проект. Помощник прочитает инструкцию и выполнит задания.</p></div><div className="quota"><strong>{me.quota.remaining}<span> / {me.quota.limit}</span></strong><small>AI-запросов до {time(me.quota.resetsAt)}</small></div></header>
      {error&&<div role="alert" className="notice error global-error">{error}<button className="link-button" onClick={()=>setError(null)} aria-label="Закрыть сообщение">×</button></div>}
      <section className="browser-controls" aria-label="Подключение Янг"><div><span className={`dot ${ready?'online':''}`}/><strong role="status">{browser?authLabels[browser.yang.state]:'Проверяем подключение Янг'}</strong><p>{browser?.yang.message??(manual&&ready?'Завершите ручное управление, чтобы обновить каталог проектов.':'Вход и одноразовый код вводятся в форме Яндекса. Успешный вход определится автоматически.')}</p></div><div className="button-row">
        {manual?<button disabled={pending} onClick={()=>void act(async()=>setBrowser(await client.exitManual()))}>Завершить ручное управление</button>:<button disabled={pending||!control||(active&&!paused)} onClick={()=>void connect(controlInUse)}>{controlInUse?'Перехватить управление':ready?'Открыть Янг':'Подключить Янг'}</button>}
      </div></section>
      {controlInUse&&<p role="status" className="notice">Браузер управляется из другой вкладки или браузера. Перехват отключит прежнее подключение и откроет управление здесь.</p>}
      {manual&&!connectingScreen&&browser?.generation&&<RemoteBrowser key={connection} generation={browser.generation} controlId={client.controlId} reconnecting={pending} onReconnect={()=>void connect()}/>}
      {selection?<SelectionPanel catalogue={catalogue} selection={selection} onChange={value=>{setSelection(value);setSaved(false);}} onSave={()=>void save()} onRefresh={()=>void act(async()=>setCatalogue(await client.refreshCatalogue()))} busy={pending} canRefresh={Boolean(ready&&!active&&browser?.mode!=='MANUAL')} valid={validSelection} saved={saved} active={active}/>:<p role="status" className="notice">Загружаем настройки выбора…</p>}
      <section className="run-toolbar" aria-label="Управление запуском"><div><span className="section-label">Новый запуск</span><p>После запуска ответы отправляются автоматически, целыми наборами.</p></div><label className="limit-field">Наборов максимум<input type="number" min={1} max={50} value={Number.isNaN(limit)?'':limit} onChange={event=>setLimit(event.target.valueAsNumber)} disabled={pending||active}/></label><button className="primary" disabled={pending||!canStart} onClick={()=>void start()}>Запустить</button></section>
      {activeRun&&view?.id!==activeRun.id&&<button className="active-run-link" disabled={pending} onClick={()=>{revision.current++;setRunId(activeRun.id);setView(null);}}>Перейти к активному запуску</button>}
      {view?<section className="run-card" aria-label="Состояние запуска"><header className="run-heading"><div><span className={`status-pill ${view.status==='UNKNOWN'||view.status==='FAILED'?'warning':''}`}>{statusLabels[view.status]}</span><span className="progress-label">Отправлено наборов: {view.processed} из {view.maxTasks}</span></div><div className="button-row">
        {pausedStatuses.has(view.status)&&<button className="primary" disabled={pending||!ready} onClick={()=>void act(async()=>{if(manual)setBrowser(await client.exitManual());updateView(await client.resume(view.id));setBrowser(await client.browser());})}>Продолжить</button>}
        {activeStatuses.has(view.status)&&<button className="stop-button" disabled={pending} onClick={()=>void act(async()=>{updateView(await client.stop(view.id));setBrowser(await client.browser());})}>Стоп</button>}
      </div></header><progress max={view.maxTasks} value={view.processed} aria-label="Прогресс запуска"/>
        {(view.selectedProject||view.selectionReason)&&<div className="selected-project">{view.selectedProject&&<h3>{view.selectedProject.title}</h3>}{view.selectionReason&&<p>{view.selectionReason}</p>}</div>}
        {view.instructionProgress&&<div className="instruction-progress"><span>Обработано разделов и примеров: {view.instructionProgress.processed} из {view.instructionProgress.total}</span><span>AI-запросов на инструкцию: {view.instructionProgress.aiRequests}</span></div>}
        {view.error&&<p role="alert" className="notice error">{view.error.message}</p>}
        {view.status==='UNKNOWN'&&<p className="notice error">Проверьте результат в Янг вручную. Приложение не будет повторно отправлять этот набор.</p>}
        <div className="run-message" role="status">{runMessages[view.status]??`Запуск ${statusLabels[view.status].toLowerCase()}. Отправлено наборов: ${view.processed}.`}</div>
        {view.current&&<TaskSetPanel key={`${view.current.suiteId}:${view.current.snapshotHash}`} task={view.current} runId={view.id}/>}
        {view.results.length>0&&<div className="results"><h3>Результаты наборов</h3><table><thead><tr><th>№</th><th>Проект / набор</th><th>Статус</th></tr></thead><tbody>{view.results.map(item=><tr key={`${item.ordinal}-${item.poolId}-${item.suiteId}`}><td>{item.ordinal}</td><td>{item.poolId}<small>{item.suiteId}</small></td><td>{resultLabels[item.status]}{item.code&&<small>{item.code}</small>}{item.answers&&<details><summary>Ответы: {item.answers.length}</summary><ul className="result-answers">{item.answers.map(answer=><li key={`${answer.partId}:${answer.fieldId}`}><span>{answer.partId} / {answer.fieldId}</span>: {Array.isArray(answer.value)?answer.value.join(', '):String(answer.value)}</li>)}</ul></details>}</td></tr>)}</tbody></table></div>}
      </section>:<section className="empty-state"><div className="empty-symbol" aria-hidden="true">↗</div><h2>{runId?'Загружаем запуск…':'Подготовьте первый запуск'}</h2><p>Подключите Янг, выберите проект или критерии автовыбора.<br/>Перед выполнением проверим инструкцию и возможности модели.</p><div className="flow"><span>01 · Вход в Янг</span><span>02 · Выбор проекта</span><span>03 · Выполнение</span></div></section>}
      <footer className="page-footer">Материалы обрабатываются на вашем сервере. «Стоп» прекращает следующие действия.</footer>
    </main>
  </div>;
}
