import { describe,expect,it } from 'vitest';
import { errorBody,normalizeWorkerError,WorkerError } from '../src/errors.js';
describe('worker error boundary',()=>{
  it('returns only reviewed DOM error codes without page text or private URLs',()=>{expect(errorBody(new Error('Frame.evaluate: INSTRUCTION_INCOMPLETE at private.example/secret'))).toEqual({code:'INSTRUCTION_INCOMPLETE',message:'INSTRUCTION_INCOMPLETE'});expect(normalizeWorkerError(new Error('ElementHandle.evaluate: STALE_TASK')).status).toBe(422);});
  it('keeps opaque native errors private and preserves intentional worker statuses',()=>{expect(errorBody(new Error('confidential'))).toEqual({code:'WORKER_ERROR',message:'WORKER_ERROR'});expect(normalizeWorkerError(null).status).toBe(500);const expected=new WorkerError('STOPPED');expect(normalizeWorkerError(expected)).toBe(expected);});
});
