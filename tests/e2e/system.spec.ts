import { test,expect,type APIRequestContext,type Page } from '@playwright/test';
import { RunViewSchema,RunSummarySchema } from '@browserskills/contracts';
import { createHash } from 'node:crypto';
import { wave } from '../test-site/server';

async function change(api:APIRequestContext,path:string,data?:unknown){
  const csrf=await(await api.get('/api/auth/csrf')).json();
  return api.post(path,{headers:{[csrf.headerName]:csrf.token},data});
}
async function login(page:Page,login:string){
  await page.goto('/');await page.getByLabel('Логин',{exact:true}).fill(login);await page.getByLabel('Пароль',{exact:true}).fill(process.env.SYSTEM_PASSWORD!);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Яндекс Задания',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Открыть браузер',exact:true}).click();await expect(page.getByText('Браузер готов',{exact:true})).toBeVisible({timeout:30_000});
}
async function view(api:APIRequestContext,id:string){const response=await api.get(`/api/runs/${id}`);expect(response.ok()).toBeTruthy();return RunViewSchema.parse(await response.json());}
async function awaitState(api:APIRequestContext,id:string,status:string){await expect.poll(async()=>{const run=await view(api,id);if(['FAILED','UNKNOWN'].includes(run.status)&&run.status!==status)throw new Error(JSON.stringify(run.error));return run.status;},{timeout:20_000,intervals:[50,100,200]}).toBe(status);return view(api,id);}
async function diagnostics(api:APIRequestContext){return(await api.get(process.env.SYSTEM_DIAGNOSTICS_URL!,{headers:{Authorization:`Bearer ${process.env.SYSTEM_DIAGNOSTICS_TOKEN}`}})).json();}

test('real services send 50 distinct confirmed tasks once and preserve full instructions',async({page})=>{
  await login(page,'alice');await page.getByRole('button',{name:'Начать',exact:true}).click();
  await expect(page.getByRole('region',{name:'Полная инструкция'})).toContainText('Example: sky -> blue.',{timeout:20_000});
  const api=page.request;const summaries=(await(await api.get('/api/runs')).json()).map((item:unknown)=>RunSummarySchema.parse(item));const id=summaries[0].id;
  const first=await awaitState(api,id,'AWAITING_CONFIRMATION');expect(first.current!.proposal).toEqual({decision:'ANSWER',optionId:'blue'});
  expect((await diagnostics(api)).sites[0].submissions).toHaveLength(0);
  const confirmed=page.waitForResponse(response=>response.url().endsWith(`/api/runs/${id}/confirm`)&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Подтвердить и отправить'}).click();
  expect((await confirmed).status()).toBe(200);
  for(let n=2;n<=50;n++){
    const current=(await awaitState(api,id,'AWAITING_CONFIRMATION')).current!;expect(current.taskId).toBe(`task-${n}`);
    const payload={requestId:crypto.randomUUID(),taskId:current.taskId,snapshotHash:current.snapshotHash,instructionHash:current.instruction.hash,optionId:'blue',confirmationNonce:current.confirmationNonce};
    const response=await change(api,`/api/runs/${id}/confirm`,payload);expect(response.status(),await response.text()).toBe(200);
    const duplicate=await change(api,`/api/runs/${id}/confirm`,payload);expect(duplicate.status(),await duplicate.text()).toBe(200);
  }
  expect((await awaitState(api,id,'COMPLETED')).processed).toBe(50);
  const evidence=await diagnostics(api);expect(evidence.sites[0].submissions).toHaveLength(50);expect(new Set(evidence.sites[0].submissions.map((item:{taskId:string})=>item.taskId)).size).toBe(50);expect(evidence.incompleteInstructions).toBe(0);
  await expect(page.getByText('Отправлено 50 из 50',{exact:true})).toBeVisible();
});

test('a lost site response remains UNKNOWN and another user cannot read the run',async({page,browser})=>{
  await login(page,'bob');const started=await change(page.request,'/api/runs',{requestId:crypto.randomUUID(),maxTasks:1});expect(started.status()).toBe(200);const id=RunViewSchema.parse(await started.json()).id;
  const current=(await awaitState(page.request,id,'AWAITING_CONFIRMATION')).current!;
  const payload={requestId:crypto.randomUUID(),taskId:current.taskId,snapshotHash:current.snapshotHash,instructionHash:current.instruction.hash,optionId:'blue',confirmationNonce:current.confirmationNonce};
  expect((await change(page.request,`/api/runs/${id}/confirm`,payload)).status()).toBe(200);
  await awaitState(page.request,id,'UNKNOWN');await change(page.request,`/api/runs/${id}/confirm`,payload);
  expect((await diagnostics(page.request)).sites[1].submissions).toHaveLength(1);
  const other=await browser.newContext({baseURL:process.env.SYSTEM_URL});
  try{const csrf=await(await other.request.get('/api/auth/csrf')).json();expect((await other.request.post('/api/auth/login',{headers:{[csrf.headerName]:csrf.token},data:{login:'alice',password:process.env.SYSTEM_PASSWORD}})).status()).toBe(200);expect((await other.request.get(`/api/runs/${id}`)).status()).toBe(404);}finally{await other.close();}
});

test('real worker image bytes reach the owner UI and stop ends the run',async({page})=>{
  await login(page,'carol');await page.getByLabel('Заданий максимум').fill('1');await page.getByRole('button',{name:'Начать',exact:true}).click();
  await expect(page.getByRole('region',{name:'Полная инструкция'})).toBeVisible({timeout:20_000});
  const image=page.getByRole('img',{name:'Изображение задания',exact:true});await expect(image).toHaveJSProperty('naturalWidth',1);
  const summary=(await(await page.request.get('/api/runs')).json())[0];const current=(await view(page.request,summary.id)).current!;
  const media=await page.request.get(`/api/runs/${summary.id}/media/${current.image!.id}`);expect(media.status()).toBe(200);expect(media.headers()['cache-control']).toContain('no-store');
  await page.getByRole('button',{name:'Стоп',exact:true}).click();await expect(page.getByText('Остановлен',{exact:true})).toBeVisible();
  expect((await diagnostics(page.request)).sites[2].submissions).toHaveLength(0);
});

for(const [loginName,index,instructionAudio] of [['david',3,false],['eve',4,true]] as const){
  test(`real ${instructionAudio?'instruction example':'task'} audio is preserved, playable and sent to the model as audio`,async({page})=>{
    await login(page,loginName);await page.getByLabel('Заданий максимум').fill('1');await page.getByRole('button',{name:'Начать',exact:true}).click();
    await expect(page.getByRole('region',{name:'Полная инструкция'})).toBeVisible({timeout:20_000});
    const summary=(await(await page.request.get('/api/runs')).json())[0];const current=(await view(page.request,summary.id)).current!;
    expect(current.aiError).toBeNull();expect(current.proposal).toEqual({decision:'ANSWER',optionId:'blue'});
    const asset=instructionAudio?current.instruction.blocks.find(block=>block.type==='audio')!.asset:current.audio!;
    const url=`/api/runs/${summary.id}/media/${asset.id}`;
    const original=await page.request.get(url);expect(original.status()).toBe(200);expect(createHash('sha256').update(await original.body()).digest('hex')).toBe(createHash('sha256').update(wave()).digest('hex'));
    const range=await page.request.get(url,{headers:{Range:'bytes=0-43'}});expect(range.status()).toBe(206);expect(await range.body()).toEqual(wave().subarray(0,44));expect(range.headers()['content-range']).toBe(`bytes 0-43/${wave().length}`);
    const player=page.locator('audio');await expect(player).toHaveJSProperty('duration',0.1);await player.evaluate(async(element:HTMLAudioElement)=>element.play());await expect(player).toHaveJSProperty('ended',true);
    if(instructionAudio)await expect(page.getByRole('region',{name:'Полная инструкция'})).toContainText('Classify the background sound, not the words.');
    await page.getByRole('button',{name:'Подтвердить и отправить'}).click();await awaitState(page.request,summary.id,'COMPLETED');
    const evidence=await diagnostics(page.request);expect(evidence.sites[index].submissions).toHaveLength(1);expect(evidence.audioAnalyses).toBeGreaterThanOrEqual(instructionAudio?2:1);expect(evidence.incompleteInstructions).toBe(0);
    expect((await page.request.get(url)).status()).toBe(404);
  });
}
