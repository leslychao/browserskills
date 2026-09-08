export class WorkerError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}

export const errorBody = (error: unknown): { code: string; message: string } => {
  const code = error instanceof WorkerError ? error.code : 'WORKER_ERROR';
  // Never copy page text, URLs, credentials or native exception details to logs/API.
  return { code, message: code };
};
