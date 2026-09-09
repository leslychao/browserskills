import type { BrowserStatus,Catalogue,Me,RunView,SelectionSettings,TaskSet } from '@browserskills/contracts';
export const user:Me={id:'30000000-0000-4000-8000-000000000001',login:'tester',quota:{limit:100,used:1,remaining:99,resetsAt:'2026-09-10T00:00:00Z'}};
export const browserStatus:BrowserStatus={workerId:'browser-1',generation:'generation-1',mode:'IDLE',url:'https://yang.yandex-team.ru/?activeTab=all',runId:null,yang:{state:'READY',checkedAt:'2026-09-09T12:00:00Z',message:null,poolId:null,suiteId:null}};
export const selection:SelectionSettings={mode:'MANUAL',poolId:null,includePoolIds:[],excludePoolIds:[],minReward:null,modalities:['text','image','audio'],includeTraining:false,includeExams:false};
export const catalogue:Catalogue={items:[
  {poolId:'pool-1',title:'Сравнения аудио',reward:{amount:'15.00',unit:'за задание'},availability:'AVAILABLE',kind:'WORK',modalities:['audio'],preparation:'READY',reason:null},
  {poolId:'pool-2',title:'Классификация текста',reward:{amount:'6.00',unit:'за задание'},availability:'AVAILABLE',kind:'WORK',modalities:['text'],preparation:'UNPREPARED',reason:null},
  {poolId:'pool-3',title:'Оценка интонации',reward:null,availability:'UNAVAILABLE',kind:'WORK',modalities:['audio'],preparation:'BLOCKED',reason:{code:'QUALITY_NOT_VERIFIED',message:'Качество модели для интонации не подтверждено'}},
],refreshedAt:'2026-09-09T12:00:00Z',activePoolId:null,activeSuiteId:null};
export const taskSet:TaskSet={
  poolId:'pool-1',suiteId:'suite-1',parts:[{id:'part-1',title:'Первая пара',text:'Сравните звучание двух записей.',
    media:[{id:'audio-1',kind:'audio',mimeType:'audio/wav',byteLength:64000,sha256:'c'.repeat(64),durationMs:2000}],
    fields:[{id:'voice',label:'Похожи ли голоса?',kind:'SINGLE_CHOICE',required:true,options:[{id:'same',label:'Похожи'},{id:'different',label:'Не похожи'}],value:'same',stage:0,maxLength:null,min:null,max:null}],unmappedControls:[]}],
  instruction:{sourceKey:'pool-1/instruction',hash:'a'.repeat(64),blocks:[{id:'rule-1',type:'text',text:'Слушайте обе записи. Не учитывайте различия в тексте.'}]},
  snapshotHash:'b'.repeat(64),expiresAt:null,adapterVersion:'test-v2',
};
export const run:RunView={id:'10000000-0000-4000-8000-000000000001',status:'ANALYZING',maxTasks:50,processed:0,createdAt:'2026-09-09T12:00:00Z',updatedAt:'2026-09-09T12:00:00Z',error:null,current:taskSet,results:[],selection:{...selection,poolId:'pool-1'},selectedProject:catalogue.items[0],selectionReason:'Выбран пользователем',instructionProgress:{processed:3,total:3,aiRequests:2}};
