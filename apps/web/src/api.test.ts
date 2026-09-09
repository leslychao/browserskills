import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ClientError } from './api';
import { browserStatus,catalogue,run,selection,user } from './test-fixtures';

const json = (body: unknown, status=200) => new Response(JSON.stringify(body), {status,headers:{'Content-Type':'application/json'}});
describe('session API client', () => {
  it('starts a run with a UUID when the LAN browser has no crypto.randomUUID', async () => {
    vi.stubGlobal('crypto', {getRandomValues:crypto.getRandomValues.bind(crypto)});
    try {
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json({token:'csrf',headerName:'X-CSRF-TOKEN'})).mockResolvedValueOnce(json(run));
      await new ApiClient(request).startRun(3,selection);
      const body = JSON.parse(request.mock.calls[1][1]!.body as string);
      expect(body.maxTasks).toBe(3);
      expect(body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally { vi.unstubAllGlobals(); }
  });
  it('gets a fresh CSRF token for each mutation and uses same-origin cookies', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({token:'first',headerName:'X-CSRF-TOKEN'})).mockResolvedValueOnce(json({id:'u',login:'demo'}))
      .mockResolvedValueOnce(json({token:'second',headerName:'X-CSRF-TOKEN'})).mockResolvedValueOnce(new Response(null,{status:204}));
    const client = new ApiClient(request);
    await client.login('demo','secret');
    await client.logout();
    expect(request.mock.calls.map(([url])=>url)).toEqual(['/api/auth/csrf','/api/auth/login','/api/auth/csrf','/api/auth/logout']);
    expect(request.mock.calls[1][1]).toMatchObject({method:'POST',credentials:'same-origin',headers:{'X-CSRF-TOKEN':'first'}});
    expect(request.mock.calls[3][1]).toMatchObject({headers:{'X-CSRF-TOKEN':'second'}});
  });
  it('never retries an uncertain automatic run start', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json({token:'csrf',headerName:'X-CSRF-TOKEN'})).mockRejectedValueOnce(new TypeError('network'));
    const client = new ApiClient(request);
    await expect(client.startRun(3,selection)).rejects.toMatchObject({code:'NETWORK_ERROR'});
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('preserves server error codes and refuses invalid API payloads', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json({code:'AUTH_REQUIRED',message:'Войдите снова'},401)).mockResolvedValueOnce(json({id:'bad'}));
    const client = new ApiClient(request);
    await expect(client.me()).rejects.toMatchObject({status:401,code:'AUTH_REQUIRED'});
    await expect(client.me()).rejects.toBeInstanceOf(ClientError);
  });
  it('does not expose unstructured server HTML as an error message', async () => {
    const client = new ApiClient(vi.fn<typeof fetch>().mockResolvedValue(new Response('<script>bad</script>',{status:502})));
    await expect(client.me()).rejects.toMatchObject({code:'HTTP_ERROR',message:'Сервер не смог выполнить запрос (502).'});
  });
  it('reads authenticated Yang status, cached catalogue, settings and history without mutations',async()=>{
    const responses:Record<string,unknown>={'/api/me':user,'/api/browser':browserStatus,'/api/yang/session':browserStatus.yang,'/api/yang/catalogue':catalogue,'/api/yang/selection':selection,'/api/runs':[(({current:_current,results:_results,...summary})=>summary)(run)],'/api/runs/run%2F1':run};
    const request=vi.fn<typeof fetch>().mockImplementation(async path=>json(responses[String(path)]));
    const client=new ApiClient(request);
    await client.me();await client.browser();await client.yangSession();await client.catalogue();await client.selection();await client.runs();await client.run('run/1');
    expect(request.mock.calls.map(([url])=>url)).toEqual(Object.keys(responses));
    expect(request.mock.calls.every(([,init])=>init?.method===undefined&&init?.credentials==='same-origin')).toBe(true);
  });
  it('uses CSRF for catalogue refresh, saved filters, manual control, resume and stop',async()=>{
    const responses:Record<string,unknown>={'/api/yang/catalogue/refresh':catalogue,'/api/yang/selection':selection,'/api/browser':browserStatus,'/api/browser/manual-control':browserStatus,'/api/runs/run%2F1/resume':run,'/api/runs/run%2F1/stop':run};
    const request=vi.fn<typeof fetch>().mockImplementation(async path=>json(String(path)==='/api/auth/csrf'?{token:'csrf',headerName:'X-CSRF-TOKEN'}:responses[String(path)]));
    const client=new ApiClient(request);
    await client.refreshCatalogue();await client.saveSelection(selection);await client.openBrowser();await client.enterManual();await client.exitManual();await client.resume('run/1');await client.stop('run/1');
    const mutations=request.mock.calls.filter(([url])=>url!=='/api/auth/csrf');
    expect(mutations.map(([,init])=>init?.method)).toEqual(['POST','PUT','POST','POST','DELETE','POST','POST']);
    expect(mutations.every(([,init])=>(init?.headers as Record<string,string>)['X-CSRF-TOKEN']==='csrf')).toBe(true);
    expect(JSON.parse(mutations[1][1]!.body as string)).toEqual(selection);
  });
});
