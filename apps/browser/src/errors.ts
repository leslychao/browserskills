export class WorkerError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}

const DOM_FAILURES=['UNSUPPORTED_TASK','STALE_TASK','AMBIGUOUS_FIELDS','MEDIA_NOT_READY','CONTEXT_TOO_LARGE','CATALOGUE_TOO_LARGE','CATALOGUE_ID_UNAVAILABLE','INSTRUCTIONS_TOO_LARGE','INSTRUCTIONS_UNSUPPORTED','INSTRUCTION_INCOMPLETE','INSTRUCTIONS_LINK_UNSUPPORTED'] as const;
/** Playwright prefixes thrown DOM errors; only source-owned codes cross the worker boundary. */
export function normalizeWorkerError(error:unknown):WorkerError{
  if(error instanceof WorkerError)return error;
  const code=error instanceof Error?DOM_FAILURES.find(code=>new RegExp(`\\b${code}\\b`).test(error.message)):undefined;
  return new WorkerError(code??'WORKER_ERROR',code?422:500);
}

export const errorBody = (error: unknown): { code: string; message: string } => {
  const code = normalizeWorkerError(error).code;
  // Never copy page text, URLs, credentials or native exception details to logs/API.
  return { code, message: code };
};
