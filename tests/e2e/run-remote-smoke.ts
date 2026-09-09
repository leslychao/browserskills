import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Explicitly authorized deployed UI smoke. It never starts a run or submits Yang answers.
const directory = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Pass the protected deployment directory.');
const origin = 'http://192.168.0.107:8080';
const output = path.join(directory, `ui-smoke-${Date.now()}`);
await mkdir(output);
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1100}});
page.setDefaultTimeout(30_000);
const report:Record<string,unknown> = {origin,startedAt:new Date().toISOString(),answersSubmitted:0,passed:false};
const failures:{path:string;status:number;code?:string}[]=[];
page.on('response',response=>{
  const route=new URL(response.url());
  if(route.origin===origin && route.pathname.startsWith('/api/') && response.status()>=400) {
    void response.json().then(body=>failures.push({path:route.pathname,status:response.status(),code:body.code})).catch(()=>failures.push({path:route.pathname,status:response.status()}));
  }
});
let stage = 'shared workspace';
try {
  await page.goto(origin);
  await expect(page.getByRole('heading',{name:'Яндекс Янг',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Войти в BrowserSkills',exact:true})).toHaveCount(0);
  expect((await page.request.get(`${origin}/api/me`)).status()).toBe(200);
  expect(await page.evaluate(()=>({secure:window.isSecureContext,protocol:location.protocol}))).toEqual({secure:false,protocol:'http:'});
  report.sharedWorkspaceWithoutLogin = true;
  stage = 'manual browser';
  const socketReady = page.waitForEvent('websocket',socket=>new URL(socket.url()).pathname==='/api/browser/view');
  await page.getByRole('button',{name:/^(Подключить Янг|Открыть Янг)$/}).click();
  const socket = await socketReady;
  const canvas = page.locator('.remote-screen canvas');
  await expect(canvas).toHaveJSProperty('width',1366);
  await expect(canvas).toHaveJSProperty('height',768);
  await expect.poll(()=>canvas.evaluate(element=>{
    const surface=element as HTMLCanvasElement;
    const pixels=surface.getContext('2d')!.getImageData(0,0,surface.width,surface.height).data;
    const colors=new Set<number>();
    for(let index=0;index<pixels.length;index+=128) if(pixels[index+3]) colors.add((pixels[index]!<<16)|(pixels[index+1]!<<8)|pixels[index+2]!);
    return colors.size;
  })).toBeGreaterThan(8);
  report.rfbFramebuffer = true;
  stage = 'browser size and clipboard controls';
  await page.getByLabel('Масштаб браузера').selectOption('actual');
  await expect.poll(()=>canvas.evaluate(element=>element.getBoundingClientRect().width)).toBe(1366);
  report.actualScalePixels = 1366;
  await page.getByRole('button',{name:'На весь экран',exact:true}).click();
  await expect.poll(()=>page.getByRole('region',{name:'Ваш браузер Яндекса'}).evaluate(element=>document.fullscreenElement===element)).toBe(true);
  report.nativeFullscreen = true;
  await page.getByRole('button',{name:'Свернуть',exact:true}).click();
  await page.getByLabel('Масштаб браузера').selectOption('fit');
  await page.getByRole('button',{name:'Буфер обмена',exact:true}).click();
  await expect(page.getByLabel('Текст для Янг',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Текст из Янг',{exact:true})).toBeVisible();
  report.clipboardControls = true;
  // Actual Unicode transfer is checked against the owned local fixture, never
  // against a user's live login/task fields or their clipboard.
  await page.getByRole('button',{name:'Буфер обмена',exact:true}).click();
  stage = 'Yang state';
  await expect.poll(async()=>page.evaluate(async()=>{
    const response=await fetch('/api/yang/session');
    return response.ok?(await response.json()).state:'UNKNOWN';
  }),{timeout:45_000}).not.toBe('UNKNOWN');
  // Only enum/status is retained; no cookies, credentials or page materials in the report.
  report.yangState = await page.evaluate(async()=>{
    const response=await fetch('/api/yang/session');
    if(!response.ok) throw new Error('Session status unavailable');
    const session=await response.json();
    return session.state;
  });
  await page.screenshot({path:path.join(output,'interface.png'),fullPage:true});
  report.httpFailures=failures;
  await expect(page.locator('.global-error')).toHaveCount(0);
  stage = 'release manual control';
  const closed=socket.waitForEvent('close');
  await page.getByRole('button',{name:'Завершить ручное управление',exact:true}).click();
  await closed;
  await expect(page.locator('.remote-screen')).toHaveCount(0);
  report.releaseRevokedSocket = true;
  report.passed = true;
} catch {
  // Keep real page content out of generic error traces.
  report.failedStage = stage;
  report.httpFailures=failures;
  process.exitCode = 1;
} finally {
  // A failed assertion must release the real manual-control session as well.
  if(await page.getByRole('button',{name:'Завершить ручное управление',exact:true}).isVisible().catch(()=>false)) {
    try {
      await page.getByRole('button',{name:'Завершить ручное управление',exact:true}).click();
      await expect(page.locator('.remote-screen')).toHaveCount(0);
    } catch { report.cleanupReleaseFailed=true; process.exitCode=1; }
  }
  await browser.close();
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,evidenceDirectory:output}));
}
