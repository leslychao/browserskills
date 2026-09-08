import { useCallback,useEffect,useRef,useState } from 'react';
import type { BrowserStatus,Me,RunSummary,RunView } from '@browserskills/contracts';
import { ApiClient,ClientError } from './api';
import { Login } from './Login';
import { RemoteBrowser } from './RemoteBrowser';
import { ReviewPanel } from './ReviewPanel';

const defaultClient=new ApiClient();
export const activeStatuses=new Set(['PREPARING','ANALYZING','AWAITING_CONFIRMATION','SUBMITTING']);
export const statusLabels:Record<RunView['status'],string>={PREPARING:'Читаем инструкцию',ANALYZING:'Анализируем задание',AWAITING_CONFIRMATION:'Нужно ваше подтверждение',SUBMITTING:'Проверяем отправку',COMPLETED:'Завершён',STOPPED:'Остановлен',INTERRUPTED:'Прерван',UNKNOWN:'Результат неизвестен',FAILED:'Ошибка'};
const time=(value:string)=>new Intl.DateTimeFormat('ru',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(value));

export function App({client=defaultClient,pollInterval=1000}:{client?:ApiClient;pollInterval?:number}) {
  const [me,setMe]=useState<Me|null>(null);
  const [initial,setInitial]=useState(true);
  const [browser,setBrowser]=useState<BrowserStatus|null>(null);
  const [runs,setRuns]=useState<RunSummary[]>([]);
  const [runId,setRunId]=useState<string|null>(null);
  const [view,setView]=useState<RunView|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [pending,setPending]=useState(false);
  const [limit,setLimit]=useState(50);
  const inFlight=useRef(false);
  const revision=useRef(0);
  const reset=useCallback(()=>{revision.current++;setMe(null);setBrowser(null);setRuns([]);setView(null);setRunId(null);},[]);
  const handleError=useCallback((cause:unknown)=>{
    if(cause instanceof ClientError&&cause.status===401)reset();
    setError(cause instanceof Error?cause.message:'Не удалось выполнить действие. Проверьте состояние сервера.');
  },[reset]);
  useEffect(()=>{
    let disposed=false;
    client.me().then(value=>{if(!disposed)setMe(value);}).catch(cause=>{if(!disposed&&!(cause instanceof ClientError&&cause.status===401))handleError(cause);}).finally(()=>{if(!disposed)setInitial(false);});
    return()=>{disposed=true;};
  },[client,handleError]);
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
        const [identity,status,list]=await Promise.all([client.me(),client.browser(),client.runs()]);
        if(disposed||currentRevision!==revision.current)return;
        setMe(identity);setBrowser(status);setRuns(list);
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
  if(!me)return <Login busy={pending} error={error} onLogin={(login,password)=>act(async()=>{await client.login(login,password);setMe(await client.me());})}/>;

  const active=runs.some(run=>activeStatuses.has(run.status))||(view!==null&&activeStatuses.has(view.status));
  const manual=browser?.mode==='MANUAL';
  const canStart=browser!==null&&browser.mode!=='CLOSED'&&!active&&Number.isInteger(limit)&&limit>=1&&limit<=50;
  return <div className="workspace">
    <aside className="sidebar"><a className="brand" href="/" aria-label="BrowserSkills"><span className="brand-mark">b.</span> BrowserSkills</a><div className="sidebar-context">Яндекс Задания<span>Рабочее пространство</span></div>
      <div className="sidebar-heading">Запуски <span>{runs.length}</span></div>
      <nav aria-label="История запусков" className="history">{runs.length===0?<p>История появится после первого запуска.</p>:runs.map(run=><button key={run.id} className={run.id===view?.id?'current':''} onClick={()=>{if(run.id!==runId){setRunId(run.id);setView(null);}}} disabled={pending}><span>{time(run.createdAt)}</span><small>{statusLabels[run.status]} · {run.processed}/{run.maxTasks}</small></button>)}</nav>
      <div className="account"><span className="avatar">{me.login.slice(0,1).toUpperCase()}</span><div><strong>{me.login}</strong><small>Личный профиль</small></div><button className="link-button" disabled={pending} onClick={()=>void act(async()=>{await client.logout();reset();})}>Выйти</button></div>
    </aside>
    <main className="main"><header className="page-heading"><div><span className="eyebrow">Ваш помощник</span><h1>Яндекс Задания</h1><p>От инструкции к ответу — с вашей проверкой.</p></div><div className="quota"><strong>{me.quota.remaining}<span> / {me.quota.limit}</span></strong><small>AI-запросов до {time(me.quota.resetsAt)}</small></div></header>
      {error&&<div role="alert" className="notice error global-error">{error}<button className="link-button" onClick={()=>setError(null)} aria-label="Закрыть сообщение">×</button></div>}
      <section className="browser-controls" aria-label="Управление браузером"><div><span className={`dot ${browser&&browser.mode!=='CLOSED'?'online':''}`}/><strong>{browser?.mode==='CLOSED'||browser===null?'Браузер не открыт':manual?'Вы управляете браузером':browser.mode==='AUTOMATION'?'Браузер выполняет запуск':'Браузер готов'}</strong><p>Войдите в Яндекс и откройте задание в своём профиле.</p></div><div className="button-row">
        {browser?.mode==='CLOSED'||browser===null?<button disabled={pending} onClick={()=>void act(async()=>setBrowser(await client.openBrowser()))}>Открыть браузер</button>:<button disabled={pending||active} onClick={()=>void act(async()=>setBrowser(manual?await client.exitManual():await client.enterManual()))}>{manual?'Завершить ручное управление':'Открыть Яндекс'}</button>}
      </div></section>
      {manual&&browser?.generation&&<RemoteBrowser generation={browser.generation}/>}
      <section className="run-toolbar" aria-label="Управление запуском"><div><span className="section-label">Новый запуск</span><p>Начнём с задания, открытого в Яндексе.</p></div><label className="limit-field">Заданий максимум<input type="number" min={1} max={50} value={Number.isNaN(limit)?'':limit} onChange={event=>setLimit(event.target.valueAsNumber)} disabled={pending||active}/></label><button className="primary" disabled={pending||!canStart} onClick={()=>void act(async()=>{const value=await client.startRun(limit);setView(value);setRunId(value.id);setBrowser(await client.browser());})}>Начать</button></section>
      {view?<section className="run-card"><header className="run-heading"><div><span className={`status-pill ${view.status==='UNKNOWN'||view.status==='FAILED'?'warning':''}`}>{statusLabels[view.status]}</span><span className="progress-label">Отправлено {view.processed} из {view.maxTasks}</span></div>{activeStatuses.has(view.status)&&<button className="stop-button" disabled={pending} onClick={()=>void act(async()=>{setView(await client.stop(view.id));setBrowser(await client.browser());})}>Стоп</button>}</header>
        <progress max={view.maxTasks} value={view.processed} aria-label="Прогресс запуска"/>
        {view.error&&<p role="alert" className="notice error">{view.error.message}</p>}
        {view.status==='UNKNOWN'&&<p className="notice error">Проверьте результат в Яндексе вручную. Приложение не будет повторно отправлять это задание.</p>}
        {view.current&&view.status==='AWAITING_CONFIRMATION'?<ReviewPanel key={`${view.current.taskId}:${view.current.snapshotHash}:${view.current.confirmationNonce}`} task={view.current} runId={view.id} busy={pending} onConfirm={optionId=>act(async()=>{const task=view.current!;setView(await client.confirm(view.id,{requestId:crypto.randomUUID(),taskId:task.taskId,snapshotHash:task.snapshotHash,instructionHash:task.instruction.hash,optionId,confirmationNonce:task.confirmationNonce}));})}/>:<div className="run-message" role="status">{view.status==='PREPARING'?'Читаем полную инструкцию и загружаем материалы…':view.status==='ANALYZING'?'Ожидаем очередь и анализ модели. Ответ ещё не отправлен.':view.status==='SUBMITTING'?'Проверяем результат в Яндексе. Повторная отправка недоступна.':`Запуск ${statusLabels[view.status].toLowerCase()}. Отправлено ответов: ${view.processed}.`}</div>}
        {view.results.length>0&&<div className="results"><h3>Результаты</h3><table><thead><tr><th>№</th><th>Задание</th><th>Статус</th></tr></thead><tbody>{view.results.map(item=><tr key={`${item.ordinal}-${item.taskId}`}><td>{item.ordinal}</td><td>{item.taskId}</td><td>{item.status==='SUBMITTED'?'Отправлено':item.status==='UNKNOWN'?'Результат неизвестен':item.status==='SUBMIT_INTENT'?'Отправка начата':item.status==='FAILED'?'Ошибка':'Подготовлено'}{item.code&&<small>{item.code}</small>}</td></tr>)}</tbody></table></div>}
      </section>:<section className="empty-state"><div className="empty-symbol" aria-hidden="true">↗</div><h2>{runId?'Загружаем запуск…':'Подготовьте первое задание'}</h2><p>Откройте браузер, войдите в Яндекс и выберите проект.<br/>Мы прочитаем инструкцию и предложим ответ.</p><div className="flow"><span>01 · Инструкция</span><span>02 · Материал</span><span>03 · Подтверждение</span></div></section>}
      <footer className="page-footer">Каждый ответ отправляется после вашего подтверждения. «Стоп» прекращает следующие действия.</footer>
    </main>
  </div>;
}
