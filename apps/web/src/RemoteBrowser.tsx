import { useEffect,useRef,useState } from 'react';
import RFB from '@novnc/novnc';

export function RemoteBrowser({generation}:{generation:string}){
  const container=useRef<HTMLDivElement>(null);
  const [state,setState]=useState<'connecting'|'connected'|'disconnected'>('connecting');
  useEffect(()=>{
    if(!container.current)return;
    setState('connecting');
    const url=new URL('/api/browser/view',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
    const rfb=new RFB(container.current,url.toString(),{shared:false});
    rfb.scaleViewport=true;rfb.resizeSession=false;rfb.viewOnly=false;
    const connect=()=>setState('connected');const disconnect=()=>setState('disconnected');
    rfb.addEventListener('connect',connect);rfb.addEventListener('disconnect',disconnect);rfb.addEventListener('securityfailure',disconnect);
    return()=>{rfb.removeEventListener('connect',connect);rfb.removeEventListener('disconnect',disconnect);rfb.removeEventListener('securityfailure',disconnect);rfb.disconnect();};
  },[generation]);
  return <section className="remote-browser" aria-label="Ваш браузер Яндекса">
    <div className="remote-title"><span className={`dot ${state==='connected'?'online':''}`}/>{state==='connected'?'Ручное управление':'Подключение к браузеру'}<small>Ваш отдельный профиль Яндекса</small></div>
    {state==='disconnected'&&<p role="alert" className="notice error">Соединение с браузером закрыто. Получите ручное управление снова.</p>}
    <div ref={container} className="remote-screen"/>
  </section>;
}
