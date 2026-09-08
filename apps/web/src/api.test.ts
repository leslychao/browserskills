import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ClientError } from './api';

const json = (body: unknown, status=200) => new Response(JSON.stringify(body), {status,headers:{'Content-Type':'application/json'}});
describe('session API client', () => {
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
  it('never retries an uncertain confirmation', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json({token:'csrf',headerName:'X-CSRF-TOKEN'})).mockRejectedValueOnce(new TypeError('network'));
    const client = new ApiClient(request);
    await expect(client.confirm('run',{requestId:'id',taskId:'task',snapshotHash:'a',instructionHash:'b',optionId:'x',confirmationNonce:'n'})).rejects.toMatchObject({code:'NETWORK_ERROR'});
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
});
