import { test,expect } from '@playwright/test';
import { browserStatus,catalogue,run,selection,user } from '../../apps/web/src/test-fixtures';

// These browser tests stub the API boundary; they do not certify real Yang or model quality.
test('manual project, autonomous whole-set observation, instruction and unknown submission',async({page})=>{
  let current=structuredClone(run);let started=false;let starts=0;const mutations:string[]=[];
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;const method=route.request().method();
    if(method!=='GET')mutations.push(path);
    const body=(value:unknown)=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
    if(path==='/api/me')return body(user);
    if(path==='/api/browser')return body({...browserStatus,mode:started?'AUTOMATION':'IDLE',runId:started?run.id:null});
    if(path==='/api/yang/catalogue')return body(catalogue);
    if(path==='/api/yang/selection')return body(method==='PUT'?route.request().postDataJSON():selection);
    if(path==='/api/runs'){
      if(method==='POST'){
        starts++;started=true;const request=route.request().postDataJSON();
        expect(request.selection.poolId).toBe('pool-1');expect(request.maxTasks).toBe(3);
        expect(route.request().headers()['x-csrf-token']).toBe('csrf-test');return body(current);
      }
      const {current:_task,results:_results,...summary}=current;return body(started?[summary]:[]);
    }
    if(path==='/api/auth/csrf')return body({token:'csrf-test',headerName:'X-CSRF-TOKEN'});
    if(path.endsWith('/media/audio-1')){
      const wav=Buffer.alloc(32044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
      return route.fulfill({contentType:'audio/wav',body:wav,headers:{'Accept-Ranges':'bytes'}});
    }
    if(path===`/api/runs/${run.id}`)return body(current);
    return route.fulfill({status:404,json:{code:'NOT_FOUND',message:'Not found'}});
  });
  await page.goto('/');
  await expect(page.getByText('Янг подключён')).toBeVisible();
  await expect(page.getByRole('button',{name:'Запустить'})).toBeDisabled();
  await page.getByRole('radio',{name:'Сравнения аудио',exact:true}).check();
  await page.getByLabel('Наборов максимум').fill('3');
  await page.getByRole('button',{name:'Запустить'}).click();
  await expect(page.getByRole('heading',{name:'Первая пара'})).toBeVisible();
  await page.getByText('Инструкция и примеры',{exact:true}).click();
  await expect(page.getByRole('region',{name:'Полная инструкция'})).toContainText('Не учитывайте различия в тексте');
  await expect(page.locator('audio')).toHaveAttribute('src',`/api/runs/${run.id}/media/audio-1`);
  await expect(page.getByRole('region',{name:'Часть 1'}).locator('input,button,textarea')).toHaveCount(0);
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:'.cache/yang-web-desktop.png',fullPage:true});
  current={...current,status:'UNKNOWN',current:null,error:{code:'UNKNOWN_SUBMIT',message:'Сайт не подтвердил отправку'},results:[{poolId:'pool-1',suiteId:'suite-1',ordinal:1,status:'UNKNOWN',answers:null,code:'TIMEOUT',createdAt:run.createdAt}]};
  await expect(page.getByText('Приложение не будет повторно отправлять этот набор.',{exact:false})).toBeVisible();
  expect(starts).toBe(1);expect(mutations.some(path=>path.endsWith('/confirm'))).toBe(false);
  await expect(page.getByRole('button',{name:'Продолжить'})).toHaveCount(0);
});

test('automatic criteria persist across reload and fit a narrow viewport',async({page})=>{
  let settings=structuredClone(selection);
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/me')return route.fulfill({json:user});
    if(path==='/api/browser')return route.fulfill({json:browserStatus});
    if(path==='/api/yang/catalogue')return route.fulfill({json:catalogue});
    if(path==='/api/runs')return route.fulfill({json:[]});
    if(path==='/api/auth/csrf')return route.fulfill({json:{token:'csrf',headerName:'X-CSRF-TOKEN'}});
    if(path==='/api/yang/selection'){
      if(route.request().method()==='PUT')settings=route.request().postDataJSON();
      return route.fulfill({json:settings});
    }
    return route.fulfill({status:404,json:{code:'NOT_FOUND',message:'Not found'}});
  });
  await page.setViewportSize({width:390,height:844});await page.goto('/');
  await page.getByRole('radio',{name:'Автоматический выбор'}).check();
  await page.getByLabel('Минимальная оплата',{exact:true}).fill('12,5');
  await page.getByLabel('Разрешённые проекты',{exact:true}).selectOption('pool-1');
  await page.getByRole('button',{name:'Сохранить настройки'}).click();
  await expect(page.getByText('Настройки сохранены')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('radio',{name:'Автоматический выбор'})).toBeChecked();
  await expect(page.getByLabel('Минимальная оплата',{exact:true})).toHaveValue('12.5');
  await expect(page.getByLabel('Разрешённые проекты',{exact:true})).toHaveValues(['pool-1']);
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth',390);
  await page.screenshot({path:'.cache/yang-web-mobile.png',fullPage:true});
});

test('login form fits mobile and never restores a password after a failed sign-in',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/auth/csrf')return route.fulfill({json:{token:'csrf',headerName:'X-CSRF-TOKEN'}});
    return route.fulfill({status:401,json:{code:'AUTH_REQUIRED',message:'Неверный логин или пароль'}});
  });
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Войти в BrowserSkills'})).toBeVisible();
  await page.getByLabel('Логин',{exact:true}).fill('tester');await page.getByLabel('Пароль',{exact:true}).fill('test-password');
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Неверный логин');
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth',390);
  await page.reload();await expect(page.getByLabel('Пароль',{exact:true})).toHaveValue('');
});
