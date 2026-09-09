import { chromium,expect,type Page } from '@playwright/test';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';

// Explicit deployment acceptance: controls only the outer BrowserSkills UI.
// No keyboard/click input is sent to Yang, and no run or answer is submitted.
const origin='http://192.168.0.107:8080';
const output=path.resolve('.cache',`remote-control-${Date.now()}`);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const pages:Page[]=[];
const controllers=new Map<Page,string>();
const sockets=new Map<Page,number>();
const report:Record<string,unknown>={origin,startedAt:new Date().toISOString(),passed:false,actionsOnYang:0};
const failures:Array<{path:string;status:number;code?:string}>=[];
const lifecycle:Array<Record<string,unknown>>=[];
const pageErrors:string[]=[];
let stage='open workspace';
async function tracked(page:Page){
  pages.push(page);sockets.set(page,0);page.setDefaultTimeout(20_000);
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('response',response=>{
    const url=new URL(response.url());
    if(url.origin===origin&&['/api/browser','/api/browser/manual-control'].includes(url.pathname))
      void response.json().then(body=>lifecycle.push({path:url.pathname,method:response.request().method(),mode:body.mode,state:body.state,status:response.status()})).catch(()=>{});
    if(url.origin===origin&&url.pathname.startsWith('/api/')&&response.status()>=400)
      void response.json().then(body=>failures.push({path:url.pathname,status:response.status(),code:body.code})).catch(()=>{});
  });
  page.on('request',request=>{
    if(new URL(request.url()).pathname==='/api/browser/manual-control'){
      const control=request.headers()['x-browser-control'];if(control)controllers.set(page,control);
    }
  });
  page.on('websocket',socket=>{if(new URL(socket.url()).pathname==='/api/browser/view')sockets.set(page,sockets.get(page)!+1);});
  await page.addInitScript(()=>{
    const state=window as unknown as {controlSockets:WebSocket[]};state.controlSockets=[];
    const NativeWebSocket=window.WebSocket;
    // Keep the native prototype: noVNC validates its own property descriptors.
    window.WebSocket=new Proxy(NativeWebSocket,{construct(target,args){
      const socket=Reflect.construct(target,args) as WebSocket;state.controlSockets.push(socket);return socket;
    }});
  });
  await page.goto(origin);await expect(page.getByRole('heading',{name:'Яндекс Янг',exact:true})).toBeVisible();
  return page;
}
async function frame(page:Page){
  const canvas=page.locator('.remote-screen canvas');
  await expect(canvas).toHaveJSProperty('width',1366);await expect(canvas).toHaveJSProperty('height',768);
  await expect.poll(()=>canvas.evaluate(element=>{
    const c=element as HTMLCanvasElement;const pixels=c.getContext('2d')!.getImageData(0,0,c.width,c.height).data;
    const colors=new Set<number>();for(let i=0;i<pixels.length;i+=128)if(pixels[i+3])colors.add((pixels[i]!<<16)|(pixels[i+1]!<<8)|pixels[i+2]!);
    return colors.size;
  })).toBeGreaterThan(8);
  await expect(page.getByRole('region',{name:'Ваш браузер Яндекса'})).toContainText('Ручное управление');
}
async function change(page:Page,method:string,controlId=controllers.get(page)!){
  return page.evaluate(async({method,controlId})=>{
    const csrf=await(await fetch('/api/csrf')).json();
    const response=await fetch('/api/browser/manual-control',{method,headers:{[csrf.headerName]:csrf.token,'X-Browser-Control':controlId}});
    return response.status;
  },{method,controlId});
}
try{
  const context=await browser.newContext();const first=await tracked(await context.newPage());
  stage='initial connect and framebuffer';
  await first.getByRole('button',{name:/^(Подключить Янг|Открыть Янг|Перехватить управление)$/}).click();await frame(first);
  report.initialFramebuffer=true;
  stage='second tab without automatic takeover';
  const second=await tracked(await context.newPage());
  await expect(second.getByRole('button',{name:'Перехватить управление'})).toBeVisible();
  expect(sockets.get(second)).toBe(0);await frame(first);
  expect(await change(second,'POST')).toBe(409);
  expect(await change(second,'DELETE')).toBe(403);
  report.passiveTabDoesNotDisconnectController=true;
  stage='explicit same-session takeover';
  await second.getByRole('button',{name:'Перехватить управление'}).click();await frame(second);
  await expect(first.locator('.remote-screen')).toHaveCount(0);
  expect(await change(first,'DELETE')).toBe(403);await frame(second);
  report.sameSessionTakeoverAndStaleRelease=true;
  stage='separate browser session';
  const third=await tracked(await browser.newPage());
  await expect(third.getByRole('button',{name:'Перехватить управление'})).toBeVisible();expect(sockets.get(third)).toBe(0);
  expect(await change(third,'DELETE',controllers.get(second)!)).toBe(403);
  await third.getByRole('button',{name:'Перехватить управление'}).click();await frame(third);
  await expect(second.locator('.remote-screen')).toHaveCount(0);report.crossSessionTakeover=true;
  stage='transport loss and explicit reconnect';
  const before=sockets.get(third)!;
  await third.evaluate(()=>{const state=window as unknown as {controlSockets:WebSocket[]};state.controlSockets.at(-1)!.close();});
  await third.getByRole('button',{name:'Переподключиться',exact:true}).click();await frame(third);
  expect(sockets.get(third)).toBe(before+1);report.transportReconnect=true;
  stage='reload and reconnect twice';
  for(let attempt=0;attempt<2;attempt++){
    const count=sockets.get(third)!;await third.reload();
    await expect(third.getByRole('button',{name:'Перехватить управление'})).toBeVisible();expect(sockets.get(third)).toBe(count);
    await third.getByRole('button',{name:'Перехватить управление'}).click();await frame(third);
  }
  report.reloadReconnect=true;
  stage='release and reacquire';
  await third.getByRole('button',{name:'Завершить ручное управление'}).click();await expect(third.locator('.remote-screen')).toHaveCount(0);
  await first.getByRole('button',{name:/^(Подключить Янг|Открыть Янг)$/}).click();await frame(first);
  report.releaseAndReacquire=true;report.passed=true;
}catch(error){
  report.failedStage=stage;report.errorType=error instanceof Error?error.name:'unknown';report.error=error instanceof Error?error.message.split('\n')[0]:'';report.httpFailures=failures;process.exitCode=1;
  report.screens=await Promise.all(pages.map(page=>page.locator('.remote-screen canvas').evaluateAll(elements=>elements.map(element=>({width:(element as HTMLCanvasElement).width,height:(element as HTMLCanvasElement).height})))));
  report.screenStates=await Promise.all(pages.map(page=>page.locator('.remote-title').allTextContents()));
  report.lifecycle=lifecycle;report.pageErrors=pageErrors;report.errors=await Promise.all(pages.map(page=>page.locator('.global-error').allTextContents()));
}finally{
  for(const page of pages){if(controllers.has(page))await change(page,'DELETE').catch(()=>{});}
  await browser.close();report.finishedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,evidenceDirectory:output}));
}
