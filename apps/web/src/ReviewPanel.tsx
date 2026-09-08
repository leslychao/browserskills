import { useEffect,useRef,useState } from 'react';
import type { InstructionBundle,MediaAsset,ReviewTask } from '@browserskills/contracts';
import { mediaUrl } from './api';

export function Media({asset,runId,caption,onUnavailable}:{asset:MediaAsset;runId:string;caption?:string;onUnavailable?:()=>void}) {
  const [failed,setFailed]=useState(false);
  const src=mediaUrl(runId,asset.id);
  const fail=()=>{setFailed(true);onUnavailable?.();};
  if(failed)return <p role="alert" className="notice error">Материал не загрузился. Обновите состояние задания перед отправкой.</p>;
  return <figure className={asset.kind==='audio'?'audio-material':'image-material'}>
    {asset.kind==='audio'?<><div className="audio-heading"><span aria-hidden="true">♫</span><span>{caption??'Исходная аудиозапись'}</span>{asset.durationMs!==undefined&&<small>{(asset.durationMs/1000).toFixed(0)} сек.</small>}</div><audio controls preload="metadata" src={src} aria-label={caption??'Аудиозапись задания'} onError={fail}/></>:<img src={src} alt={caption??'Изображение задания'} onError={fail}/>}
    {caption&&asset.kind==='image'&&<figcaption>{caption}</figcaption>}
  </figure>;
}
export function Instructions({instruction,runId,onUnavailable}:{instruction:InstructionBundle;runId:string;onUnavailable?:()=>void}){
  return <section className="instructions" aria-label="Полная инструкция">
    <div className="section-label">Инструкция к заданию</div>
    {instruction.blocks.map((block,index)=>block.type==='text'?<div className="instruction-text" key={index}>{block.text}</div>:<Media key={`${index}-${block.asset.id}`} asset={block.asset} caption={block.caption} runId={runId} onUnavailable={onUnavailable}/>)}
  </section>;
}
export function ReviewPanel({task,runId,onConfirm,busy}:{task:ReviewTask;runId:string;onConfirm:(optionId:string)=>Promise<void>;busy:boolean}){
  const proposed=task.proposal?.decision==='ANSWER'?task.proposal.optionId:'';
  const [selected,setSelected]=useState(proposed);
  const [consumed,setConsumed]=useState(false);
  const [mediaFailed,setMediaFailed]=useState(false);
  const guard=useRef(false);
  useEffect(()=>{setSelected(proposed);setConsumed(false);setMediaFailed(false);guard.current=false;},[task.taskId,task.snapshotHash,task.instruction.hash,task.confirmationNonce,proposed]);
  const expired=task.expiresAt!==null&&Date.parse(task.expiresAt)<=Date.now();
  const valid=task.options.some(option=>option.id===selected);
  const submit=async()=>{
    if(guard.current||busy||expired||mediaFailed||!valid)return;
    guard.current=true;setConsumed(true);
    try{await onConfirm(selected);}catch{/* The owner displays the request error; never re-enable an uncertain nonce. */}
  };
  return <div className="review-grid">
    <Instructions instruction={task.instruction} runId={runId} onUnavailable={()=>setMediaFailed(true)}/>
    <section className="task-content" aria-label="Проверка ответа">
      <div className="section-label">Текущее задание</div>
      <h2>{task.question||'Изучите материал и выберите ответ'}</h2>
      {task.image&&<Media asset={task.image} runId={runId} onUnavailable={()=>setMediaFailed(true)}/>}
      {task.audio&&<Media asset={task.audio} runId={runId} onUnavailable={()=>setMediaFailed(true)}/>}
      {task.aiError&&<p role="status" className="notice">{task.aiError.message}</p>}
      {task.proposal?.decision==='ABSTAIN'&&<p className="notice">Модель не предложила ответ. Выберите вариант самостоятельно.</p>}
      <fieldset disabled={busy||consumed||expired||mediaFailed} className="options"><legend>Выберите ответ</legend>
        {task.options.map(option=><label className={`option ${selected===option.id?'selected':''}`} key={option.id}>
          <input type="radio" name="answer" aria-label={option.label} value={option.id} checked={selected===option.id} onChange={()=>setSelected(option.id)}/>
          <span>{option.label}</span>{proposed===option.id&&<small>Предложение модели</small>}
        </label>)}
      </fieldset>
      {expired&&<p role="alert" className="notice error">Время задания истекло. Ответ не будет отправлен.</p>}
      <div className="confirm-area"><button className="primary" disabled={busy||consumed||expired||mediaFailed||!valid} onClick={()=>void submit()}>Подтвердить и отправить</button>
        <p>{consumed?'Проверяем результат отправки. Повторное нажатие недоступно.':'После подтверждения ответ будет отправлен в Яндекс.'}</p>
      </div>
    </section>
  </div>;
}
