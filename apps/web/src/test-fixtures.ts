import type { BrowserStatus, Me, ReviewTask, RunView } from '@browserskills/contracts';
export const user:Me={id:'30000000-0000-4000-8000-000000000001',login:'tester',quota:{limit:100,used:1,remaining:99,resetsAt:'2026-09-10T00:00:00Z'}};
export const browserStatus:BrowserStatus={workerId:'browser-1',generation:'generation-1',mode:'IDLE',url:'https://tasks.yandex.ru/task',runId:null};
export const reviewTask:ReviewTask={
  projectId:'project-1',taskId:'task-1',question:'Какой звук слышен на фоне?',
  instruction:{sourceKey:'project-1/instruction',hash:'a'.repeat(64),blocks:[{type:'text',text:'Определите фоновый звук. Не учитывайте речь человека.\nПример: звук сирены → «Сирена».'}]},
  image:null,audio:{id:'audio-1',kind:'audio',mimeType:'audio/wav',byteLength:64000,sha256:'c'.repeat(64),durationMs:2000},
  options:[{id:'siren',label:'Сирена'},{id:'speech',label:'Речь'}],snapshotHash:'b'.repeat(64),expiresAt:null,adapterVersion:'test-v1',
  proposal:{decision:'ANSWER',optionId:'siren'},aiError:null,confirmationNonce:'nonce-1',
};
export const run:RunView={id:'10000000-0000-4000-8000-000000000001',status:'AWAITING_CONFIRMATION',maxTasks:50,processed:0,createdAt:'2026-09-09T12:00:00Z',updatedAt:'2026-09-09T12:00:00Z',error:null,current:reviewTask,results:[]};
