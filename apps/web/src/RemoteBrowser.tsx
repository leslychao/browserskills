import { useEffect,useId,useRef,useState,type ClipboardEvent,type KeyboardEvent } from 'react';
import RFB from '@novnc/novnc';
import './RemoteBrowser.css';

const clipboardLimit=64*1024;
const clipboardFits=(text:string)=>new TextEncoder().encode(text).byteLength<=clipboardLimit;

export function RemoteBrowser({generation,controlId,onReconnect,reconnecting}:{generation:string;controlId:string;onReconnect:()=>void;reconnecting:boolean}){
  const panel=useRef<HTMLElement>(null);
  const container=useRef<HTMLDivElement>(null);
  const connection=useRef<RFB|null>(null);
  const pasteTarget=useRef<HTMLTextAreaElement>(null);
  const copiedText=useRef<HTMLTextAreaElement>(null);
  const clipboardId=useId();
  const [state,setState]=useState<'connecting'|'connected'|'disconnected'>('connecting');
  const [expanded,setExpanded]=useState(false);
  const [scale,setScale]=useState('fit');
  const [clipboardOpen,setClipboardOpen]=useState(false);
  const [draft,setDraft]=useState('');
  const [received,setReceived]=useState('');
  const [message,setMessage]=useState('');
  useEffect(()=>{
    if(!container.current)return;
    setState('connecting');setDraft('');setReceived('');setMessage('');
    const url=new URL('/api/browser/view',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
    url.searchParams.set('controlId',controlId);
    const rfb=new RFB(container.current,url.toString(),{shared:false});
    connection.current=rfb;
    rfb.scaleViewport=true;rfb.clipViewport=false;rfb.resizeSession=false;rfb.viewOnly=false;
    const connect=()=>setState('connected');
    const disconnect=()=>{setState('disconnected');setDraft('');setReceived('');setMessage('');};
    const clipboard=(event:Event)=>{
      const text=(event as CustomEvent<{text:string}>).detail.text;
      if(!clipboardFits(text)){setReceived('');setMessage('Буфер обмена ограничен 64 КиБ. Передайте текст меньшими частями.');return;}
      setReceived(text);setMessage(text?'Получен текст из Янг. Откройте «Буфер обмена», чтобы скопировать его на компьютер.':'');
    };
    rfb.addEventListener('connect',connect);rfb.addEventListener('disconnect',disconnect);rfb.addEventListener('securityfailure',disconnect);rfb.addEventListener('clipboard',clipboard);
    return()=>{connection.current=null;rfb.removeEventListener('connect',connect);rfb.removeEventListener('disconnect',disconnect);rfb.removeEventListener('securityfailure',disconnect);rfb.removeEventListener('clipboard',clipboard);rfb.disconnect();};
  },[generation,controlId]);
  useEffect(()=>{if(connection.current)connection.current.scaleViewport=scale==='fit';},[scale,generation,controlId]);
  useEffect(()=>{
    const change=()=>setExpanded(document.fullscreenElement===panel.current);
    document.addEventListener('fullscreenchange',change);
    return()=>document.removeEventListener('fullscreenchange',change);
  },[]);
  useEffect(()=>{
    if(!expanded)return;
    const overflow=document.body.style.overflow;document.body.style.overflow='hidden';
    const escape=(event:globalThis.KeyboardEvent)=>{
      if(event.key==='Escape'&&!document.fullscreenElement){event.preventDefault();event.stopPropagation();setExpanded(false);}
    };
    document.addEventListener('keydown',escape,true);
    return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',escape,true);};
  },[expanded]);
  const toggleFullscreen=async()=>{
    if(expanded){
      if(document.fullscreenElement===panel.current)await document.exitFullscreen();
      setExpanded(false);return;
    }
    setExpanded(true);
    // Embedded hosts may deny Fullscreen API; the same panel still fills their window.
    try{await panel.current?.requestFullscreen?.();}catch{/* Window expansion stays usable. */}
  };
  const paste=(text:string)=>{
    const rfb=connection.current;if(!rfb||state!=='connected'||!text)return;
    if(!clipboardFits(text)){setMessage('Буфер обмена ограничен 64 КиБ. Передайте текст меньшими частями.');return;}
    rfb.clipboardPasteFrom(text);
    rfb.sendKey(0xffe3,'ControlLeft',true);rfb.sendKey(0x76,'KeyV',true);
    rfb.sendKey(0x76,'KeyV',false);rfb.sendKey(0xffe3,'ControlLeft',false);
    rfb.focus();setDraft('');setMessage('Текст передан в выбранное поле Янг.');
  };
  const hostPaste=(event:ClipboardEvent)=>{
    event.preventDefault();event.stopPropagation();paste(event.clipboardData.getData('text/plain'));
    if(pasteTarget.current)pasteTarget.current.value='';
    connection.current?.focus();
  };
  const capturePasteShortcut=(event:KeyboardEvent)=>{
    if(state!=='connected'||event.altKey)return;
    if(((event.ctrlKey||event.metaKey)&&(event.code==='KeyV'||event.key.toLowerCase()==='v'))||(event.shiftKey&&event.key==='Insert')){
      // Let the browser perform a native paste into an editable target on LAN HTTP.
      // Stop noVNC's key handler from preventing that browser paste event.
      event.stopPropagation();
      // noVNC listens for keyup on its canvas only. Release modifiers before
      // moving focus, including when an empty/oversized paste is rejected.
      for(const [keysym,code] of [[0xffe3,'ControlLeft'],[0xffe4,'ControlRight'],[0xffe1,'ShiftLeft'],[0xffe2,'ShiftRight'],[0xffeb,'MetaLeft'],[0xffec,'MetaRight']] as const)connection.current?.sendKey(keysym,code,false);
      pasteTarget.current?.focus();
    }
  };
  const copyToHost=()=>{
    const field=copiedText.current;if(!field||!received)return;
    field.focus();field.select();
    // Explicit selection + user gesture also works on HTTP, where async Clipboard API is absent.
    let copied=false;try{copied=document.execCommand('copy');}catch{/* Native Ctrl+C remains available. */}
    setMessage(copied?'Скопировано в буфер компьютера.':'Текст выделен. Нажмите Ctrl+C, чтобы скопировать его на компьютер.');
  };
  return <section ref={panel} className={`remote-browser${expanded?' expanded':''}`} aria-label="Ваш браузер Яндекса">
    <div className="remote-title"><div className="remote-connection"><span className={`dot ${state==='connected'?'online':''}`}/>{state==='connected'?'Ручное управление':state==='disconnected'?'Связь с браузером потеряна':'Подключение к браузеру'}</div>
      <div className="remote-actions"><select aria-label="Масштаб браузера" value={scale} onChange={event=>setScale(event.target.value)}><option value="fit">Вписать в окно</option><option value="actual">100%</option></select>
        <button aria-expanded={clipboardOpen} aria-controls={clipboardId} className={received?'clipboard-ready':''} onClick={()=>setClipboardOpen(!clipboardOpen)}>Буфер обмена</button>
        <button aria-pressed={expanded} onClick={()=>void toggleFullscreen()}>{expanded?'Свернуть':'На весь экран'}</button>
      </div>
    </div>
    {state==='disconnected'&&<div role="alert" className="notice error">Соединение с экраном браузера прервано. Переподключение восстановит ручное управление.<button disabled={reconnecting} onClick={onReconnect}>Переподключиться</button></div>}
    {clipboardOpen&&<div id={clipboardId} className="remote-clipboard">
      <div><label htmlFor={`${clipboardId}-out`}>Текст для Янг</label><textarea id={`${clipboardId}-out`} value={draft} onChange={event=>setDraft(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Вставьте текст с компьютера через Ctrl+V"/><button disabled={state!=='connected'||!draft} onClick={()=>paste(draft)}>Вставить в Янг</button><p>Сначала выберите нужное поле в серверном браузере.</p></div>
      <div><label htmlFor={`${clipboardId}-in`}>Текст из Янг</label><textarea id={`${clipboardId}-in`} ref={copiedText} value={received} readOnly spellCheck={false} placeholder="Выделите текст в Янг и нажмите Ctrl+C"/><button disabled={state!=='connected'||!received} onClick={copyToHost}>Скопировать на компьютер</button></div>
    </div>}
    {message&&<p role="status" className="remote-hint">{message}</p>}
    <div className="remote-viewport" onPaste={hostPaste} onKeyDownCapture={capturePasteShortcut}>
      <textarea ref={pasteTarget} className="remote-paste-target sr-only" aria-hidden="true" tabIndex={-1} autoComplete="off" onPaste={hostPaste} onKeyUp={()=>connection.current?.focus()}/>
      <div ref={container} className="remote-screen"/>
    </div>
  </section>;
}
