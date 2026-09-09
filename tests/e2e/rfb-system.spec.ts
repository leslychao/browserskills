import { test,expect,type Page } from '@playwright/test';

async function framebuffer(page:Page){
  const canvas=page.locator('.remote-screen canvas');
  await expect(canvas).toHaveJSProperty('width',1366);await expect(canvas).toHaveJSProperty('height',768);
  // Dimensions alone prove the handshake, not that x11vnc actually sent painted pixels.
  await expect.poll(()=>canvas.evaluate(element=>{
    const canvas=element as HTMLCanvasElement;const pixels=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;
    const colors=new Set<number>();for(let offset=0;offset<pixels.length;offset+=128)if(pixels[offset+3])colors.add((pixels[offset]!<<16)|(pixels[offset+1]!<<8)|pixels[offset+2]!);
    return colors.size;
  })).toBeGreaterThan(8);
}

test('insecure HTTP noVNC paints and reconnects; session ownership, automation and logout revoke live sockets',async({page,browser})=>{
  await page.goto('/');expect(await page.evaluate(()=>({secure:window.isSecureContext,host:location.hostname,protocol:location.protocol}))).toEqual({secure:false,host:'rfb-http.test',protocol:'http:'});
  await page.getByLabel('Логин',{exact:true}).fill('alice');await page.getByLabel('Пароль',{exact:true}).fill(process.env.SYSTEM_PASSWORD!);await page.getByRole('button',{name:'Войти',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Яндекс Янг',exact:true})).toBeVisible();
  const socketOpened=page.waitForEvent('websocket',socket=>socket.url().endsWith('/api/browser/view'));
  await page.getByRole('button',{name:'Подключить Янг',exact:true}).click();await socketOpened;
  await expect(page.getByRole('region',{name:'Ваш браузер Яндекса'})).toContainText('Ручное управление',{timeout:20_000});
  await framebuffer(page);
  await page.screenshot({path:'artifacts/ui-rfb.png',fullPage:true});
  const reconnecting=page.waitForEvent('websocket',event=>event.url().endsWith('/api/browser/view'));
  await page.reload();const reconnected=await reconnecting;
  // Playwright clears old WebSocket tracking on main-frame navigation. Verify the
  // replacement's RFB handshake here; actual close events are checked below.
  await expect(page.getByRole('region',{name:'Ваш браузер Яндекса'})).toContainText('Ручное управление',{timeout:20_000});
  expect(await page.evaluate(()=>window.isSecureContext)).toBe(false);await framebuffer(page);
  const other=await browser.newContext({baseURL:process.env.SYSTEM_URL});
  try{
    // Use Chromium fetch so the same fixture-only DNS rule applies to this separate session.
    const otherPage=await other.newPage();await otherPage.goto('/');expect(await otherPage.evaluate(()=>window.isSecureContext)).toBe(false);
    const result=await otherPage.evaluate(async password=>{
      const csrf=await(await fetch('/api/auth/csrf')).json();
      const login=await fetch('/api/auth/login',{method:'POST',headers:{[csrf.headerName]:csrf.token,'Content-Type':'application/json'},body:JSON.stringify({login:'alice',password})});
      const rotated=await(await fetch('/api/auth/csrf')).json();
      const manual=await fetch('/api/browser/manual-control',{method:'POST',headers:{[rotated.headerName]:rotated.token}});
      return {login:login.status,manual:manual.status};
    },process.env.SYSTEM_PASSWORD!);
    expect(result).toEqual({login:200,manual:409});
  }finally{await other.close();}
  await page.getByLabel('Наборов максимум').fill('50');
  await page.getByLabel('Автоматический выбор', {exact:true}).check();
  const closed=reconnected.waitForEvent('close');await page.getByRole('button',{name:'Запустить',exact:true}).click();await closed;
  await expect(page.locator('.remote-screen')).toHaveCount(0);
  await page.getByRole('button',{name:'Стоп',exact:true}).click();await expect(page.getByText('Остановлен',{exact:true})).toBeVisible();
  const reopened=page.waitForEvent('websocket',event=>event.url().endsWith('/api/browser/view'));await page.getByRole('button',{name:/^(Подключить Янг|Открыть Янг)$/}).click();const second=await reopened;
  await expect(page.getByRole('region',{name:'Ваш браузер Яндекса'})).toContainText('Ручное управление',{timeout:20_000});const logoutClosed=second.waitForEvent('close');await page.getByRole('button',{name:'Выйти',exact:true}).click();await logoutClosed;
  await expect(page.getByRole('heading',{name:'Войти в BrowserSkills',exact:true})).toBeVisible();
});
