import {test,expect,type APIRequestContext,type Page} from '@playwright/test';
import {RunViewSchema,defaultSelection,CatalogueSchema} from '@browserskills/contracts';

async function change(api:APIRequestContext,path:string,data?:unknown){
  const csrf=await(await api.get('/api/auth/csrf')).json();
  return api.post(path,{headers:{[csrf.headerName]:csrf.token},data});
}
async function login(page:Page,login:string){
  await page.goto('/');await page.getByLabel('Логин',{exact:true}).fill(login);await page.getByLabel('Пароль',{exact:true}).fill(process.env.SYSTEM_PASSWORD!);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Яндекс Янг',exact:true})).toBeVisible();
  const opened=await change(page.request,'/api/browser');expect(opened.status(),await opened.text()).toBe(200);
  await expect.poll(async()=> (await(await page.request.get('/api/yang/session')).json()).state,{timeout:30000}).toBe('READY');
  const catalogue=await change(page.request,'/api/yang/catalogue/refresh');expect(catalogue.status(),await catalogue.text()).toBe(200);
  return CatalogueSchema.parse(await catalogue.json());
}
async function view(api:APIRequestContext,id:string){const response=await api.get('/api/runs/'+id);expect(response.ok()).toBeTruthy();return RunViewSchema.parse(await response.json());}
async function awaitState(api:APIRequestContext,id:string,status:string){
  await expect.poll(async()=>{const run=await view(api,id);if(['FAILED','UNKNOWN','WAITING_FOR_USER','WAITING_FOR_AUTH'].includes(run.status)&&run.status!==status)throw new Error(JSON.stringify(run.error));return run.status;},{timeout:120000,intervals:[100,200,400]}).toBe(status);
  return view(api,id);
}
async function start(api:APIRequestContext,maxTasks:number,poolId:string|null=null){
  const response=await change(api,'/api/runs',{requestId:crypto.randomUUID(),maxTasks,selection:{...defaultSelection(),mode:poolId?'MANUAL':'AUTO',poolId}});
  expect(response.status(),await response.text()).toBe(200);return RunViewSchema.parse(await response.json());
}
async function diagnostics(api:APIRequestContext){return(await api.get(process.env.SYSTEM_DIAGNOSTICS_URL!,{headers:{Authorization:'Bearer '+process.env.SYSTEM_DIAGNOSTICS_TOKEN}})).json();}

test('real services autonomously send 50 distinct whole sets and prepare complete instructions once',async({page})=>{
  const catalogue=await login(page,'alice');expect(catalogue.items).toHaveLength(1);
  const run=await start(page.request,50);
  const completed=await awaitState(page.request,run.id,'COMPLETED');expect(completed.processed).toBe(50);
  expect(completed.results).toHaveLength(50);expect(completed.results.every(r=>r.status==='SUBMITTED'&&r.answers&&r.answers.length>=2)).toBe(true);
  const evidence=await diagnostics(page.request);expect(evidence.sites[0].submissions).toHaveLength(50);
  expect(new Set(evidence.sites[0].submissions).size).toBe(50);expect(evidence.instructionAnalyses).toBeGreaterThan(0);
  expect(evidence.sites[0].reservations).toBe(1);
  await expect(page.getByText('Отправлено наборов: 50 из 50',{exact:true})).toBeVisible();
  expect((await change(page.request,'/api/runs/'+run.id+'/confirm',{optionId:'untrusted'})).status()).toBe(404);
});

test('lost external acknowledgement stops UNKNOWN and a later run cannot repeat that suite',async({page,browser})=>{
  await login(page,'bob');const run=await start(page.request,1);await awaitState(page.request,run.id,'UNKNOWN');
  expect((await diagnostics(page.request)).sites[1].submissions).toHaveLength(1);
  expect((await change(page.request,'/api/runs/'+run.id+'/resume')).status()).toBe(409);
  await change(page.request,'/api/browser');const later=await start(page.request,1);
  await expect.poll(async()=>['WAITING_FOR_USER','FAILED','UNKNOWN'].includes((await view(page.request,later.id)).status),{timeout:30000}).toBe(true);
  expect((await diagnostics(page.request)).sites[1].submissions).toHaveLength(1);
  const other=await browser.newContext({baseURL:process.env.SYSTEM_URL});
  try{
    expect((await change(other.request,'/api/auth/login',{login:'alice',password:process.env.SYSTEM_PASSWORD})).status()).toBe(200);
    expect((await other.request.get('/api/runs/'+run.id)).status()).toBe(404);
  }finally{await other.close();}
});

for(const [name,index,pairs] of [['carol',2,5],['david',3,3]] as const){
  test('whole audio '+name+' uses all '+pairs+' pairs and sends exactly one outer submission',async({page})=>{
    const catalogue=await login(page,name);const run=await start(page.request,1,catalogue.items[0].poolId);
    const completed=await awaitState(page.request,run.id,'COMPLETED');expect(completed.processed).toBe(1);
    const answers=completed.results[0].answers!;expect(new Set(answers.map(a=>a.partId)).size).toBe(pairs);
    expect(answers).toHaveLength(pairs*(name==='carol'?3:19));
    const evidence=await diagnostics(page.request);expect(evidence.sites[index].submissions).toHaveLength(1);expect(evidence.audioAnalyses).toBeGreaterThan(0);
  });
}

test('conditional required fields discovered after filling are answered before submission',async({page})=>{
  await login(page,'eve');const run=await start(page.request,1);const completed=await awaitState(page.request,run.id,'COMPLETED');
  expect(completed.results[0].answers).toHaveLength(2);
  expect(completed.results[0].answers?.some(a=>a.value==='Fixture explanation')).toBe(true);
  expect((await diagnostics(page.request)).sites[4].submissions).toHaveLength(1);
});
