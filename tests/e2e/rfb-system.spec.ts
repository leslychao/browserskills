import { test,expect } from '@playwright/test';

test('real noVNC, Spring proxy and Docker x11vnc connect; automation and logout revoke live sockets',async({page,browser})=>{
  await page.goto('/');await page.getByLabel('Логин',{exact:true}).fill('alice');await page.getByLabel('Пароль',{exact:true}).fill(process.env.SYSTEM_PASSWORD!);await page.getByRole('button',{name:'Войти',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Яндекс Задания',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Открыть браузер',exact:true}).click();await expect(page.getByText('Браузер готов',{exact:true})).toBeVisible({timeout:30_000});
  const socketOpened=page.waitForEvent('websocket',socket=>socket.url().endsWith('/api/browser/view'));
  await page.getByRole('button',{name:'Открыть Яндекс',exact:true}).click();await socketOpened;
  await expect(page.getByRole('region',{name:'Ваш браузер Яндекса'})).toContainText('Ручное управление',{timeout:20_000});
  await expect(page.locator('.remote-screen canvas')).toHaveJSProperty('width',1366);
  await expect(page.locator('.remote-screen canvas')).toHaveJSProperty('height',768);
  await page.screenshot({path:'artifacts/ui-rfb.png',fullPage:true});
  const reconnecting=page.waitForEvent('websocket',event=>event.url().endsWith('/api/browser/view'));
  await page.reload();const reconnected=await reconnecting;
  // Playwright clears old WebSocket tracking on main-frame navigation. Verify the
  // replacement's RFB handshake here; actual close events are checked below.
  await expect(page.getByRole('region',{name:'Ваш браузер Яндекса'})).toContainText('Ручное управление',{timeout:20_000});
  await expect(page.locator('.remote-screen canvas')).toHaveJSProperty('width',1366);
  const other=await browser.newContext({baseURL:process.env.SYSTEM_URL});
  try{
    const csrf=await(await other.request.get('/api/auth/csrf')).json();expect((await other.request.post('/api/auth/login',{headers:{[csrf.headerName]:csrf.token},data:{login:'alice',password:process.env.SYSTEM_PASSWORD}})).status()).toBe(200);
    const rotated=await(await other.request.get('/api/auth/csrf')).json();expect((await other.request.post('/api/browser/manual-control',{headers:{[rotated.headerName]:rotated.token}})).status()).toBe(409);
  }finally{await other.close();}
  await page.getByLabel('Заданий максимум').fill('1');const closed=reconnected.waitForEvent('close');await page.getByRole('button',{name:'Начать',exact:true}).click();await closed;
  await expect(page.locator('.remote-screen')).toHaveCount(0);await expect(page.getByRole('region',{name:'Полная инструкция'})).toBeVisible({timeout:20_000});
  await page.getByRole('button',{name:'Стоп',exact:true}).click();await expect(page.getByText('Остановлен',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Открыть браузер',exact:true}).click();await expect(page.getByText('Браузер готов',{exact:true})).toBeVisible({timeout:30_000});
  const reopened=page.waitForEvent('websocket',event=>event.url().endsWith('/api/browser/view'));await page.getByRole('button',{name:'Открыть Яндекс',exact:true}).click();const second=await reopened;
  await expect(page.getByRole('region',{name:'Ваш браузер Яндекса'})).toContainText('Ручное управление',{timeout:20_000});const logoutClosed=second.waitForEvent('close');await page.getByRole('button',{name:'Выйти',exact:true}).click();await logoutClosed;
  await expect(page.getByRole('heading',{name:'Войти в BrowserSkills',exact:true})).toBeVisible();
});
