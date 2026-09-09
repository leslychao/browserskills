import type { Catalogue,Modality,SelectionSettings } from '@browserskills/contracts';

export const modalityLabels:Record<Modality,string>={text:'Текст',image:'Изображения',audio:'Аудио'};
const preparationLabels={UNPREPARED:'Требуется подготовка',READY:'Подготовлен',BLOCKED:'Автоматическая работа недоступна'};
const kindLabels={WORK:'Задания',TRAINING:'Обучение',EXAM:'Экзамен'};

export function SelectionPanel({catalogue,selection,onChange,onSave,onRefresh,busy,canRefresh,valid,saved,active}:{catalogue:Catalogue|null;selection:SelectionSettings;onChange:(value:SelectionSettings)=>void;onSave:()=>void;onRefresh:()=>void;busy:boolean;canRefresh:boolean;valid:boolean;saved:boolean;active:boolean}) {
  const items=catalogue?.items??[];
  const change=(value:Partial<SelectionSettings>)=>onChange({...selection,...value});
  const filterOptions=[...new Map([...items.map(item=>[item.poolId,item.title] as const),...selection.includePoolIds.filter(id=>!items.some(item=>item.poolId===id)).map(id=>[id,`Проект ${id} (сейчас отсутствует)`] as const),...selection.excludePoolIds.filter(id=>!items.some(item=>item.poolId===id)).map(id=>[id,`Проект ${id} (сейчас отсутствует)`] as const)]).entries()];
  const setFilter=(key:'includePoolIds'|'excludePoolIds',values:string[])=>{
    const other=key==='includePoolIds'?'excludePoolIds':'includePoolIds';
    change({[key]:values,[other]:selection[other].filter(id=>!values.includes(id))});
  };
  return <section className="selection-panel" aria-label="Выбор заданий">
    <header className="selection-heading"><div><span className="section-label">Выбор заданий</span><h2>С чего начнём</h2></div><button disabled={busy||!canRefresh} onClick={onRefresh}>Обновить каталог</button></header>
    <fieldset className="mode-options" disabled={busy}><legend className="sr-only">Режим выбора</legend>
      <label><input type="radio" name="selection-mode" checked={selection.mode==='MANUAL'} onChange={()=>change({mode:'MANUAL'})}/>Выбрать проект</label>
      <label><input type="radio" name="selection-mode" checked={selection.mode==='AUTO'} onChange={()=>change({mode:'AUTO',poolId:null})}/>Автоматический выбор</label>
    </fieldset>
    {selection.mode==='AUTO'&&<div className="automatic-filters"><p>Максимальная указанная оплата среди доступных подходящих проектов. Цена без известной единицы не участвует в сравнении.</p>
      <div className="filter-grid"><label>Разрешённые проекты<select aria-label="Разрешённые проекты" multiple aria-describedby="allow-help" disabled={busy} value={selection.includePoolIds} onChange={event=>setFilter('includePoolIds',[...event.target.selectedOptions].map(option=>option.value))}>{filterOptions.map(([id,title])=><option key={id} value={id}>{title}</option>)}</select><small id="allow-help">Пустой список разрешает все проекты. Ctrl / ⌘ — выбрать несколько.</small></label>
        <label>Исключённые проекты<select aria-label="Исключённые проекты" multiple disabled={busy} value={selection.excludePoolIds} onChange={event=>setFilter('excludePoolIds',[...event.target.selectedOptions].map(option=>option.value))}>{filterOptions.map(([id,title])=><option key={id} value={id}>{title}</option>)}</select><small>Добавление сюда убирает проект из разрешённых.</small></label>
        <label>Минимальная оплата<input type="text" inputMode="decimal" placeholder="Без ограничения" disabled={busy} value={selection.minReward??''} onChange={event=>change({minReward:event.target.value===''?null:event.target.value.replace(',','.')})}/></label>
      </div>
      <fieldset className="modality-options" disabled={busy}><legend>Допустимые материалы</legend>{(['text','image','audio'] as const).map(modality=><label key={modality}><input type="checkbox" checked={selection.modalities.includes(modality)} onChange={event=>change({modalities:event.target.checked?[...selection.modalities,modality]:selection.modalities.filter(value=>value!==modality)})}/>{modalityLabels[modality]}</label>)}</fieldset>
      <div className="checkbox-row"><label><input type="checkbox" disabled={busy} checked={selection.includeTraining} onChange={event=>change({includeTraining:event.target.checked})}/>Включать обучение</label><label><input type="checkbox" disabled={busy} checked={selection.includeExams} onChange={event=>change({includeExams:event.target.checked})}/>Включать экзамены</label></div>
    </div>}
    {selection.mode==='MANUAL'&&catalogue?.activeSuiteId&&<label className="active-suite"><input type="radio" aria-label="Набор, открытый в серверном браузере" name="pool" checked={selection.poolId===null} disabled={busy} onChange={()=>change({poolId:null})}/>Набор, открытый в серверном браузере<small>{catalogue.activeSuiteId}</small></label>}
    {items.length===0?<p className="catalogue-empty">{catalogue?.refreshedAt?'Доступных проектов пока нет. Обновите каталог позже.':'Подключите Янг и обновите каталог.'}</p>:<div className="project-grid">{items.map(item=><article key={item.poolId} className={`project-card ${selection.mode==='MANUAL'&&selection.poolId===item.poolId?'selected':''}`}>
      <div className="project-title">{selection.mode==='MANUAL'?<label><input type="radio" name="pool" aria-label={item.title} checked={selection.poolId===item.poolId} disabled={busy||item.availability==='UNAVAILABLE'||item.preparation==='BLOCKED'} onChange={()=>change({poolId:item.poolId})}/><h3>{item.title}</h3></label>:<h3>{item.title}</h3>}<span className="reward">{item.reward?<><strong>{item.reward.amount}</strong><small>{item.reward.unit}</small></>:<small>Оплата неизвестна</small>}</span></div>
      <p className="project-meta">{kindLabels[item.kind]} · {item.availability==='ACTIVE'?'В работе':item.availability==='AVAILABLE'?'Доступен':'Недоступен'} · {item.modalities.length?item.modalities.map(modality=>modalityLabels[modality]).join(', '):'Материалы уточняются'}</p>
      <p className={`preparation ${item.preparation==='BLOCKED'?'blocked':''}`}>{preparationLabels[item.preparation]}</p>{item.reason&&<p className="project-reason">{item.reason.message}</p>}
    </article>)}</div>}
    {selection.mode==='MANUAL'&&selection.poolId&&!items.some(item=>item.poolId===selection.poolId)&&<p className="notice">Выбранный проект сейчас отсутствует в каталоге. Выберите другой проект или обновите каталог.</p>}
    <footer className="selection-footer"><div><p>{active?'Изменения применятся к следующему запуску.':'При запуске текущие настройки будут сохранены.'}</p>{!valid&&<p role="alert">Укажите неотрицательную оплату и хотя бы один вид материалов.</p>}{saved&&<span role="status">Настройки сохранены</span>}</div><button disabled={busy||!valid} onClick={onSave}>Сохранить настройки</button></footer>
  </section>;
}
