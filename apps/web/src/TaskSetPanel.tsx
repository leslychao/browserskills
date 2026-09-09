import type { TaskField,TaskSet } from '@browserskills/contracts';
import { Instructions,Media } from './Materials';

const fieldValue=(field:TaskField)=>{
  if(field.value===null||field.value===''||(Array.isArray(field.value)&&field.value.length===0))return 'Не заполнено';
  const label=(value:string)=>field.options.find(option=>option.id===value)?.label??value;
  return Array.isArray(field.value)?field.value.map(label).join(', '):typeof field.value==='string'?label(field.value):String(field.value);
};
export function TaskSetPanel({task,runId}:{task:TaskSet;runId:string}) {
  return <div className="task-set-panel"><div className="task-set-heading"><span className="section-label">Текущий набор</span><p>{task.suiteId} · частей: {task.parts.length}</p><small>Показаны значения, считанные из формы. Решения проверяются перед общей отправкой.</small></div>
    <details className="instruction-disclosure"><summary>Инструкция и примеры</summary><Instructions instruction={task.instruction} runId={runId}/></details>
    <div className="task-parts">{task.parts.map((part,index)=><section className="task-part" key={part.id} aria-label={`Часть ${index+1}`}><span className="section-label">Часть {index+1} из {task.parts.length}</span><h2>{part.title||`Задание ${index+1}`}</h2>{part.text&&<p className="task-text">{part.text}</p>}
      {part.media.map((asset,mediaIndex)=><Media key={`${asset.id}:${asset.sha256}`} asset={asset} runId={runId} caption={`${asset.kind==='audio'?'Аудиозапись':'Изображение'} ${mediaIndex+1}`}/>)}
      <dl className="field-values">{part.fields.map(field=><div key={field.id}><dt>{field.label}{field.required&&<span className="required-mark" aria-label="Обязательное поле"> *</span>}</dt><dd>{fieldValue(field)}</dd></div>)}</dl>
      {part.unmappedControls.length>0&&<p className="notice">Распознаём дополнительные элементы формы: {part.unmappedControls.length}. Отправка пока недоступна.</p>}
    </section>)}</div>
  </div>;
}
