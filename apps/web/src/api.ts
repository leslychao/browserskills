import { z } from 'zod';
import { ApiErrorSchema,BrowserStatusSchema,CatalogueSchema,MeSchema,RunSummarySchema,RunViewSchema,SelectionSettingsSchema,YangSessionSchema } from '@browserskills/contracts';
import type { SelectionSettings } from '@browserskills/contracts';
import { newRequestId } from './request-id';

export class ClientError extends Error {
  constructor(public readonly status:number,public readonly code:string,message:string){super(message);this.name='ClientError';}
}
export class ApiClient {
  constructor(private readonly fetcher: typeof fetch = (...args)=>fetch(...args)) {}
  private async request<T>(path:string,schema:z.ZodType<T>,init:RequestInit={}):Promise<T> {
    let response:Response;
    try { response = await this.fetcher(path,{...init,credentials:'same-origin',cache:'no-store'}); }
    catch {throw new ClientError(0,'NETWORK_ERROR','Связь с сервером потеряна. Не повторяйте отправку ответа: дождитесь обновления статуса.');}
    let body:unknown;
    try {body=response.status===204?undefined:await response.json();} catch {body=undefined;}
    if(!response.ok){
      const error=ApiErrorSchema.safeParse(body);
      throw new ClientError(response.status,error.success?error.data.code:'HTTP_ERROR',error.success?error.data.message:`Сервер не смог выполнить запрос (${response.status}).`);
    }
    const parsed=schema.safeParse(body);
    if(!parsed.success)throw new ClientError(502,'INVALID_RESPONSE','Сервер вернул неожиданный ответ. Обновите состояние перед дальнейшими действиями.');
    return parsed.data;
  }
  private async change<T>(path:string,schema:z.ZodType<T>,body?:unknown,method='POST') {
    const csrf=await this.request('/api/auth/csrf',z.object({token:z.string(),headerName:z.string()}));
    return this.request(path,schema,{method,headers:{'Content-Type':'application/json',[csrf.headerName]:csrf.token},...(body===undefined?{}:{body:JSON.stringify(body)})});
  }
  login(login:string,password:string){return this.change('/api/auth/login',z.object({id:z.string(),login:z.string()}),{login,password});}
  logout(){return this.change('/api/auth/logout',z.void());}
  me(){return this.request('/api/me',MeSchema);}
  browser(){return this.request('/api/browser',BrowserStatusSchema);}
  openBrowser(){return this.change('/api/browser',BrowserStatusSchema);}
  enterManual(){return this.change('/api/browser/manual-control',BrowserStatusSchema);}
  exitManual(){return this.change('/api/browser/manual-control',BrowserStatusSchema,undefined,'DELETE');}
  yangSession(){return this.request('/api/yang/session',YangSessionSchema);}
  catalogue(){return this.request('/api/yang/catalogue',CatalogueSchema);}
  refreshCatalogue(){return this.change('/api/yang/catalogue/refresh',CatalogueSchema);}
  selection(){return this.request('/api/yang/selection',SelectionSettingsSchema);}
  saveSelection(selection:SelectionSettings){return this.change('/api/yang/selection',SelectionSettingsSchema,selection,'PUT');}
  runs(){return this.request('/api/runs',z.array(RunSummarySchema));}
  run(id:string){return this.request(`/api/runs/${encodeURIComponent(id)}`,RunViewSchema);}
  startRun(maxTasks:number,selection:SelectionSettings,requestId=newRequestId()){return this.change('/api/runs',RunViewSchema,{maxTasks,selection,requestId});}
  resume(id:string){return this.change(`/api/runs/${encodeURIComponent(id)}/resume`,RunViewSchema);}
  stop(id:string){return this.change(`/api/runs/${encodeURIComponent(id)}/stop`,RunViewSchema);}
}
export const mediaUrl=(runId:string,assetId:string)=>`/api/runs/${encodeURIComponent(runId)}/media/${encodeURIComponent(assetId)}`;
