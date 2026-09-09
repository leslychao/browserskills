import { test,expect,type Page,type WebSocket } from '@playwright/test';

async function remoteNavigate(page:Page,path:string){
  // Actual RFB keyboard input, not direct Playwright access to the remote page.
  await page.locator('.remote-screen canvas').focus();
  await page.keyboard.press('Control+l');
  await page.keyboard.type(`${process.env.SYSTEM_RFB_REMOTE_FIXTURE_URL}${path}`);
  await page.keyboard.press('Enter');
}

async function clipboardAndSize(page:Page){
  const canvas=page.locator('.remote-screen canvas');
  const region=page.getByRole('region',{name:'Ваш браузер Яндекса'});
  const sockets:WebSocket[]=[];const opened=(socket:WebSocket)=>{if(new URL(socket.url()).pathname==='/api/browser/view')sockets.push(socket);};page.on('websocket',opened);
  await expect.poll(()=>canvas.evaluate(element=>element.getBoundingClientRect().width)).toBeLessThan(1366);
  await page.getByLabel('Масштаб браузера').selectOption('actual');
  await expect.poll(()=>canvas.evaluate(element=>element.getBoundingClientRect().width)).toBe(1366);
  await expect.poll(()=>page.locator('.remote-screen').evaluate(element=>[element,...element.querySelectorAll('*')].some(node=>node.scrollWidth>node.clientWidth&&getComputedStyle(node).overflowX==='auto'))).toBe(true);
  await page.getByRole('button',{name:'На весь экран',exact:true}).click();
  await expect.poll(()=>region.evaluate(element=>document.fullscreenElement===element)).toBe(true);
  await expect(region).toHaveCSS('height',`${page.viewportSize()!.height}px`);
  await page.getByRole('button',{name:'Свернуть',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>document.fullscreenElement===null)).toBe(true);
  await page.getByLabel('Масштаб браузера').selectOption('fit');
  await expect.poll(()=>canvas.evaluate(element=>element.getBoundingClientRect().width)).toBeLessThan(1366);

  const report=async()=>{const response=await page.request.get(`${process.env.SYSTEM_RFB_FIXTURE_URL}/clipboard-report`);expect(response.ok()).toBe(true);return response.json() as Promise<{text:string;copies:number;visits:number;ready:boolean}>;};
  await remoteNavigate(page,'/clipboard');
  await expect.poll(async()=>(await report()).visits).toBe(1);
  await expect.poll(async()=>(await report()).ready).toBe(true);
  const remoteText='Серверный Chromium: русский текст 😀\nSecond line: ёжик — готов.';
  await canvas.focus();await page.keyboard.press('Control+a');await page.keyboard.press('Control+c');
  await expect.poll(report).toMatchObject({copies:1});
  await page.getByRole('button',{name:'Буфер обмена',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Текст из Янг',exact:true})).toHaveValue(remoteText);
  // User-gesture copy/paste requires no navigator.clipboard or permissions on HTTP.
  await page.getByRole('button',{name:'Скопировать на компьютер',exact:true}).click();
  await page.getByRole('textbox',{name:'Текст для Янг',exact:true}).press('Control+v');
  await expect(page.getByRole('textbox',{name:'Текст для Янг',exact:true})).toHaveValue(remoteText);
  await canvas.focus();await page.keyboard.press('Tab');
  const outgoing='С компьютера: проверка Ёжик 🦔\nLine two — точный многострочный текст.';
  await page.getByRole('textbox',{name:'Текст для Янг',exact:true}).fill(outgoing);
  await page.getByRole('button',{name:'Вставить в Янг',exact:true}).click();
  // Independent input events prove actual Chromium insertion, not clipboard echo.
  await expect.poll(async()=>(await report()).text).toBe(outgoing);
  const boundary='я'.repeat(32768); // Exactly 64 KiB UTF-8, before RFB framing/NUL.
  await canvas.focus();await page.keyboard.press('Control+a');
  await page.getByRole('textbox',{name:'Текст для Янг',exact:true}).fill(boundary);
  await page.getByRole('button',{name:'Вставить в Янг',exact:true}).click();
  await expect.poll(async()=>(await report()).text===boundary).toBe(true);
  await canvas.focus();await page.keyboard.press('Control+a');await page.keyboard.press('Control+v');
  await expect.poll(async()=>(await report()).text).toBe(remoteText);
  await remoteNavigate(page,'/');
  await expect(page.getByRole('status').filter({hasText:'Янг подключён'})).toBeVisible({timeout:15_000});
  await page.getByRole('button',{name:'Буфер обмена',exact:true}).click();
  expect(sockets).toHaveLength(0);page.off('websocket',opened);
}

async function framebuffer(page:Page){
  const canvas=page.locator('.remote-screen canvas');
  await expect(canvas).toHaveJSProperty('width',1366);await expect(canvas).toHaveJSProperty('height',768);
  // Dimensions alone prove the handshake, not that TigerVNC actually sent painted pixels.
  await expect.poll(()=>canvas.evaluate(element=>{
    const canvas=element as HTMLCanvasElement;const pixels=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;
    const colors=new Set<number>();for(let offset=0;offset<pixels.length;offset+=128)if(pixels[offset+3])colors.add((pixels[offset]!<<16)|(pixels[offset+1]!<<8)|pixels[offset+2]!);
    return colors.size;
  })).toBeGreaterThan(8);
}

test('HTTP real RFB Unicode clipboard, fullscreen and scaling; ownership/reconnect/revocation',async({page,browser})=>{
  await page.goto('/');expect(await page.evaluate(()=>({secure:window.isSecureContext,host:location.hostname,protocol:location.protocol}))).toEqual({secure:false,host:'rfb-http.test',protocol:'http:'});
  await expect(page.getByRole('heading',{name:'Яндекс Янг',exact:true})).toBeVisible();
  const socketOpened=page.waitForEvent('websocket',socket=>new URL(socket.url()).pathname==='/api/browser/view');
  await page.getByRole('button',{name:'Подключить Янг',exact:true}).click();await socketOpened;
  await expect(page.getByRole('region',{name:'Ваш браузер Яндекса'})).toContainText('Ручное управление',{timeout:20_000});
  await framebuffer(page);
  await clipboardAndSize(page);
  await page.screenshot({path:'artifacts/ui-rfb.png',fullPage:true});
  const reconnecting=page.waitForEvent('websocket',event=>new URL(event.url()).pathname==='/api/browser/view');
  await page.reload();await page.getByRole('button',{name:'Перехватить управление',exact:true}).click();const reconnected=await reconnecting;
  // Playwright clears old WebSocket tracking on main-frame navigation. Verify the
  // replacement's RFB handshake here; actual close events are checked below.
  await expect(page.getByRole('region',{name:'Ваш браузер Яндекса'})).toContainText('Ручное управление',{timeout:20_000});
  expect(await page.evaluate(()=>window.isSecureContext)).toBe(false);await framebuffer(page);
  const other=await browser.newContext({baseURL:process.env.SYSTEM_URL});
  try{
    // Use Chromium fetch so the same fixture-only DNS rule applies to this separate session.
    const otherPage=await other.newPage();await otherPage.goto('/');expect(await otherPage.evaluate(()=>window.isSecureContext)).toBe(false);
    const result=await otherPage.evaluate(async()=>{
      const csrf=await(await fetch('/api/csrf')).json();
      const manual=await fetch('/api/browser/manual-control',{method:'POST',headers:{[csrf.headerName]:csrf.token,'X-Browser-Control':'70000000-0000-4000-8000-000000000002'}});
      return manual.status;
    });
    expect(result).toBe(409);
  }finally{await other.close();}
  await page.getByLabel('Наборов максимум').fill('50');
  await page.getByLabel('Автоматический выбор', {exact:true}).check();
  const closed=reconnected.waitForEvent('close',{timeout:10_000});await page.getByRole('button',{name:'Запустить',exact:true}).click();await closed;
  await expect(page.locator('.remote-screen')).toHaveCount(0);
  await page.getByRole('button',{name:'Стоп',exact:true}).click();await expect(page.getByText('Остановлен',{exact:true})).toBeVisible();
  const reopened:WebSocket[]=[];const record=(socket:WebSocket)=>{if(new URL(socket.url()).pathname==='/api/browser/view')reopened.push(socket);};page.on('websocket',record);
  await page.getByRole('button',{name:/^(Подключить Янг|Открыть Янг)$/}).click();
  const release=page.getByRole('button',{name:'Завершить ручное управление',exact:true});await expect(release).toBeEnabled();
  await expect(page.getByRole('region',{name:'Ваш браузер Яндекса'})).toContainText('Ручное управление',{timeout:20_000});await framebuffer(page);
  // OPEN must not mount an intermediate connection using stale ownership.
  await expect.poll(()=>reopened.filter(socket=>!socket.isClosed()).length).toBe(1);
  expect(reopened).toHaveLength(1);
  const second=reopened.findLast(socket=>!socket.isClosed())!;const released=second.waitForEvent('close',{timeout:10_000});await release.click();await released;page.off('websocket',record);
  await expect(page.locator('.remote-screen')).toHaveCount(0);
});
