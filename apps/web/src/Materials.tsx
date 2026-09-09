import { useState } from 'react';
import type { InstructionBundle,MediaAsset } from '@browserskills/contracts';
import { mediaUrl } from './api';

export function Media({asset,runId,caption}:{asset:MediaAsset;runId:string;caption?:string}) {
  const src=mediaUrl(runId,asset.id);
  const [failedSource,setFailedSource]=useState<string|null>(null);
  if(failedSource===src)return <p role="alert" className="notice error">Материал не загрузился. Состояние выполнения обновляется с сервера.</p>;
  return <figure className={asset.kind==='audio'?'audio-material':'image-material'}>
    {asset.kind==='audio'?<><div className="audio-heading"><span aria-hidden="true">♫</span><span>{caption??'Исходная аудиозапись'}</span>{asset.durationMs!==undefined&&<small>{(asset.durationMs/1000).toFixed(0)} сек.</small>}</div><audio controls preload="metadata" src={src} aria-label={caption??'Аудиозапись задания'} onError={()=>setFailedSource(src)}/></>:<img src={src} alt={caption??'Изображение задания'} onError={()=>setFailedSource(src)}/>}
    {caption&&asset.kind==='image'&&<figcaption>{caption}</figcaption>}
  </figure>;
}

export function Instructions({instruction,runId}:{instruction:InstructionBundle;runId:string}) {
  return <section className="instructions" aria-label="Полная инструкция"><div className="section-label">Инструкция к заданию</div>
    {instruction.blocks.map((block,index)=>block.type==='text'?<div className="instruction-text" key={index}>{block.text}</div>:<Media key={`${index}-${block.asset.id}`} asset={block.asset} caption={block.caption} runId={runId}/>)}
  </section>;
}
