import { test,expect } from '@playwright/test';
import { browserStatus,run,user } from '../../apps/web/src/test-fixtures';

// Frontend boundary tests deliberately stub the API. They are not evidence of real Yandex/model support.
test('instruction, audio, confirmation, polling and unknown submission in a real browser',async({page})=>{
  let current=structuredClone(run);let sends=0;
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const body=(value:unknown)=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
    if(path==='/api/me')return body(user);
    if(path==='/api/browser')return body({...browserStatus,mode:'AUTOMATION',runId:run.id});
    if(path==='/api/runs'){
      const {current:_task,results:_results,...summary}=current;
      return body([summary]);
    }
    if(path==='/api/auth/csrf')return body({token:'csrf-test',headerName:'X-CSRF-TOKEN'});
    if(path.endsWith('/confirm')){
      sends++;const request=route.request().postDataJSON();
      expect(request.instructionHash).toBe(current.current!.instruction.hash);
      expect(request.optionId).toBe('speech');
      expect(route.request().headers()['x-csrf-token']).toBe('csrf-test');
      current={...current,status:'UNKNOWN',current:null,error:{code:'UNKNOWN_SUBMIT',message:'Сайт не подтвердил отправку'}};
      return route.abort('connectionreset');
    }
    if(path.endsWith('/media/audio-1')){
      const wav=Buffer.alloc(32044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
      return route.fulfill({contentType:'audio/wav',body:wav,headers:{'Accept-Ranges':'bytes'}});
    }
    if(path===`/api/runs/${run.id}`)return body(current);
    return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({code:'NOT_FOUND',message:'Not found'})});
  });
  await page.goto('/');
  await expect(page.getByRole('region',{name:'Полная инструкция'})).toContainText('Не учитывайте речь человека');
  await expect(page.getByRole('radio',{name:'Сирена',exact:true})).toBeChecked();
  await expect(page.locator('audio')).toHaveAttribute('src',`/api/runs/${run.id}/media/audio-1`);
  expect(sends).toBe(0);
  await page.getByRole('radio',{name:'Речь',exact:true}).check();
  await page.getByRole('button',{name:'Подтвердить и отправить'}).click();
  await expect(page.getByText('Проверьте результат в Яндексе вручную.',{exact:false})).toBeVisible();
  expect(sends).toBe(1);
  await expect(page.getByRole('button',{name:'Подтвердить и отправить'})).toHaveCount(0);
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
  await page.getByLabel('Логин',{exact:true}).fill('tester');
  await page.getByLabel('Пароль',{exact:true}).fill('test-password');
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Неверный логин');
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth',390);
  await page.reload();
  await expect(page.getByLabel('Пароль',{exact:true})).toHaveValue('');
});
