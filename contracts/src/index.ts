import { z } from 'zod';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const identifier=z.string().min(1).max(256);
const decimal=z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/);
const unique=(items:readonly string[])=>new Set(items).size===items.length;
export const ApiErrorSchema=z.object({code:z.string(),message:z.string()}).strict();
export const ModalitySchema=z.enum(['text','image','audio']);
export const CapabilitySchema=z.enum(['TEXT','IMAGE','SPEECH','SOUND_PROSODY']);
export const OptionSchema=z.object({id:identifier,label:z.string().min(1).max(2048)}).strict();
export const MediaAssetSchema=z.object({
  id:identifier,kind:z.enum(['image','audio']),mimeType:z.string().min(1).max(128),
  byteLength:z.number().int().positive().max(20*1024*1024),sha256:hash,
  durationMs:z.number().int().positive().max(120_000).optional(),
}).strict();
export const InstructionBlockSchema=z.discriminatedUnion('type',[
  z.object({id:identifier,type:z.literal('text'),text:z.string().min(1).max(262144)}).strict(),
  z.object({id:identifier,type:z.literal('image'),asset:MediaAssetSchema,caption:z.string().max(8192).optional()}).strict(),
  z.object({id:identifier,type:z.literal('audio'),asset:MediaAssetSchema,caption:z.string().max(8192).optional()}).strict(),
]);
export const InstructionBundleSchema=z.object({
  sourceKey:identifier,hash,blocks:z.array(InstructionBlockSchema).min(1).max(4096),
}).strict().refine(v=>unique(v.blocks.map(b=>b.id)),{message:'Duplicate instruction block identifiers'});
export const YangSessionSchema=z.object({
  state:z.enum(['LOGIN_REQUIRED','TWO_FACTOR_REQUIRED','READY','AUTH_EXPIRED','UNKNOWN']),
  checkedAt:z.iso.datetime(),message:z.string().nullable(),poolId:identifier.nullable(),suiteId:identifier.nullable(),
}).strict();
export const CatalogueItemSchema=z.object({
  poolId:identifier,title:z.string().min(1).max(4096),reward:z.object({amount:decimal,unit:z.string().min(1).max(128)}).strict().nullable(),
  availability:z.enum(['AVAILABLE','ACTIVE','UNAVAILABLE']),kind:z.enum(['WORK','TRAINING','EXAM']),
  modalities:z.array(ModalitySchema).max(3),preparation:z.enum(['UNPREPARED','READY','BLOCKED']),reason:ApiErrorSchema.nullable(),
}).strict();
export const CatalogueSchema=z.object({
  items:z.array(CatalogueItemSchema).max(500),refreshedAt:z.iso.datetime().nullable(),
  activePoolId:identifier.nullable(),activeSuiteId:identifier.nullable(),
}).strict().refine(v=>unique(v.items.map(x=>x.poolId)),{message:'Duplicate catalogue pools'});
export const SelectionSettingsSchema=z.object({
  mode:z.enum(['MANUAL','AUTO']),poolId:identifier.nullable(),includePoolIds:z.array(identifier).max(500),excludePoolIds:z.array(identifier).max(500),
  minReward:decimal.nullable(),modalities:z.array(ModalitySchema).min(1).max(3),includeTraining:z.boolean(),includeExams:z.boolean(),
}).strict().refine(v=>unique(v.includePoolIds)&&unique(v.excludePoolIds)&&unique(v.modalities)&&!v.includePoolIds.some(id=>v.excludePoolIds.includes(id)),{message:'Conflicting or duplicate selection filters'});
export const defaultSelection=():SelectionSettings=>({mode:'MANUAL',poolId:null,includePoolIds:[],excludePoolIds:[],minReward:null,modalities:['text','image','audio'],includeTraining:false,includeExams:false});

export const FieldValueSchema=z.union([z.string().max(16384),z.array(identifier).max(100),z.number().finite()]);
export const TaskFieldSchema=z.object({
  id:identifier,label:z.string().min(1).max(8192),kind:z.enum(['SINGLE_CHOICE','MULTI_CHOICE','TEXT','NUMBER']),required:z.boolean(),
  options:z.array(OptionSchema).max(100),value:FieldValueSchema.nullable(),stage:z.number().int().min(0).max(20),
  maxLength:z.number().int().positive().max(16384).nullable(),min:z.number().finite().nullable(),max:z.number().finite().nullable(),
}).strict().refine(f=>unique(f.options.map(o=>o.id))&&(['SINGLE_CHOICE','MULTI_CHOICE'].includes(f.kind)?f.options.length>=2:f.options.length===0)&&(f.min===null||f.max===null||f.min<=f.max),{message:'Invalid field definition'});
export const UnmappedControlSchema=z.object({id:identifier,label:z.string().max(2048),context:z.string().max(8192),selected:z.boolean().nullable()}).strict();
export const TaskPartSchema=z.object({
  id:identifier,title:z.string().max(8192),text:z.string().max(262144),media:z.array(MediaAssetSchema).max(100),
  fields:z.array(TaskFieldSchema).max(200),unmappedControls:z.array(UnmappedControlSchema).max(200),
}).strict().refine(p=>unique(p.fields.map(f=>f.id))&&unique(p.unmappedControls.map(c=>c.id))&&p.media.every(m=>m.kind!=='audio'||(m.durationMs!==undefined&&m.durationMs<=60_000)),{message:'Duplicate fields or invalid working audio'});
export const TaskSetSchema=z.object({
  poolId:identifier,suiteId:identifier,parts:z.array(TaskPartSchema).min(1).max(50),instruction:InstructionBundleSchema,
  snapshotHash:hash,expiresAt:z.iso.datetime().nullable(),adapterVersion:identifier,
}).strict().refine(v=>unique(v.parts.map(p=>p.id)),{message:'Duplicate task parts'});
export const FieldAnswerSchema=z.object({partId:identifier,fieldId:identifier,value:FieldValueSchema}).strict();
export const AnswerSetSchema=z.object({
  decision:z.enum(['ANSWER','ABSTAIN']),answers:z.array(FieldAnswerSchema).max(10000),reason:z.string().max(4096).nullable(),
}).strict().refine(v=>(v.decision==='ANSWER'?v.answers.length>0:v.answers.length===0)&&unique(v.answers.map(a=>JSON.stringify([a.partId,a.fieldId]))),{message:'Invalid or duplicate answers'});
export const FieldGroupingSchema=z.object({partId:identifier,fieldId:identifier,label:z.string().min(1).max(8192),kind:z.enum(['SINGLE_CHOICE','MULTI_CHOICE']),controlIds:z.array(identifier).min(2).max(100)}).strict();
export const SubmitPayloadSchema=z.object({poolId:identifier,suiteId:identifier,snapshotHash:hash,instructionHash:hash,answers:z.array(FieldAnswerSchema).max(10000)}).strict();

/** Validate against the observed schema, never against ids supplied by the model alone. */
export function validateAnswers(task:TaskSet,answers:FieldAnswer[],complete:boolean):string[]{
  const errors=new Set<string>();const seen=new Set<string>();
  for(const answer of answers){
    const key=JSON.stringify([answer.partId,answer.fieldId]);
    if(seen.has(key))errors.add('DUPLICATE_FIELD_ANSWER');seen.add(key);
    const field=task.parts.find(p=>p.id===answer.partId)?.fields.find(f=>f.id===answer.fieldId);
    if(!field){errors.add('UNKNOWN_FIELD');continue;}
    const value=answer.value;
    const valid=field.kind==='SINGLE_CHOICE'?typeof value==='string'&&field.options.some(o=>o.id===value)
      :field.kind==='MULTI_CHOICE'?Array.isArray(value)&&unique(value)&&(!field.required||value.length>0)&&value.every(id=>field.options.some(o=>o.id===id))
      :field.kind==='NUMBER'?typeof value==='number'&&Number.isFinite(value)&&(field.min===null||value>=field.min)&&(field.max===null||value<=field.max)
      :typeof value==='string'&&(!field.required||value.trim().length>0)&&value.length<=(field.maxLength??16384);
    if(!valid)errors.add('INVALID_FIELD_VALUE');
  }
  if(complete)for(const part of task.parts){
    if(part.unmappedControls.length)errors.add('UNMAPPED_CONTROLS');
    for(const field of part.fields)if(field.required&&!seen.has(JSON.stringify([part.id,field.id])))errors.add('MISSING_REQUIRED_FIELD');
  }
  return [...errors];
}

export const RunStatusSchema=z.enum(['SELECTING','PREPARING','ANALYZING','FILLING','WAITING_FOR_AUTH','WAITING_FOR_USER','SUBMITTING','COMPLETED','STOPPED','INTERRUPTED','UNKNOWN','FAILED']);
export const InstructionProgressSchema=z.object({processed:z.number().int().nonnegative(),total:z.number().int().nonnegative(),aiRequests:z.number().int().nonnegative()}).strict();
export const RunItemResultSchema=z.object({
  poolId:identifier,suiteId:identifier,ordinal:z.number().int().positive(),status:z.enum(['DRAFT','SUBMIT_INTENT','SUBMITTED','UNKNOWN','FAILED']),
  answers:z.array(FieldAnswerSchema).nullable(),code:z.string().nullable(),createdAt:z.iso.datetime(),
}).strict();
export const RunSummarySchema=z.object({
  id:z.uuid(),status:RunStatusSchema,maxTasks:z.number().int().min(1).max(50),processed:z.number().int().min(0).max(50),
  createdAt:z.iso.datetime(),updatedAt:z.iso.datetime(),error:ApiErrorSchema.nullable(),selection:SelectionSettingsSchema,
  selectedProject:CatalogueItemSchema.nullable(),selectionReason:z.string().nullable(),instructionProgress:InstructionProgressSchema.nullable(),
}).strict();
export const RunViewSchema=RunSummarySchema.extend({current:TaskSetSchema.nullable(),results:z.array(RunItemResultSchema)});
export const StartRunSchema=z.object({requestId:z.uuid(),maxTasks:z.number().int().min(1).max(50),selection:SelectionSettingsSchema}).strict();
export const BrowserStatusSchema=z.object({
  workerId:identifier,generation:z.string().nullable(),mode:z.enum(['CLOSED','IDLE','MANUAL','AUTOMATION']),url:z.string().nullable(),runId:z.string().nullable(),yang:YangSessionSchema,
}).strict();
export const MeSchema=z.object({id:z.uuid(),login:z.string(),quota:z.object({limit:z.number().int(),used:z.number().int(),remaining:z.number().int(),resetsAt:z.iso.datetime()}).strict()}).strict();
const commandBase={id:z.uuid(),generation:z.string().optional(),runId:z.string().optional()};
export const WorkerCommandSchema=z.discriminatedUnion('type',[
  z.object({...commandBase,type:z.enum(['OPEN','ENTER_MANUAL','EXIT_MANUAL','BEGIN','SNAPSHOT','YANG_SESSION','PAUSE','STOP','CLOSE'])}).strict(),
  z.object({...commandBase,type:z.literal('CATALOGUE'),payload:z.object({refresh:z.boolean()}).strict()}).strict(),
  z.object({...commandBase,type:z.enum(['INSTRUCTION','SELECT_PROJECT']),payload:z.object({poolId:identifier}).strict()}).strict(),
  z.object({...commandBase,type:z.literal('MAP_FIELDS'),payload:z.object({suiteId:identifier,snapshotHash:hash,groups:z.array(FieldGroupingSchema).min(1).max(200)}).strict()}).strict(),
  z.object({...commandBase,type:z.enum(['APPLY','SUBMIT']),payload:SubmitPayloadSchema}).strict(),
]);
export const SubmitResultSchema=z.object({outcome:z.enum(['SUBMITTED','COMPLETE','UNKNOWN','REJECTED']),nextSuiteId:z.string().optional(),code:z.string().optional()}).strict();
export type ApiError=z.infer<typeof ApiErrorSchema>;
export type Modality=z.infer<typeof ModalitySchema>;
export type Capability=z.infer<typeof CapabilitySchema>;
export type Option=z.infer<typeof OptionSchema>;
export type MediaAsset=z.infer<typeof MediaAssetSchema>;
export type InstructionBlock=z.infer<typeof InstructionBlockSchema>;
export type InstructionBundle=z.infer<typeof InstructionBundleSchema>;
export type YangSession=z.infer<typeof YangSessionSchema>;
export type CatalogueItem=z.infer<typeof CatalogueItemSchema>;
export type Catalogue=z.infer<typeof CatalogueSchema>;
export type SelectionSettings=z.infer<typeof SelectionSettingsSchema>;
export type TaskField=z.infer<typeof TaskFieldSchema>;
export type TaskPart=z.infer<typeof TaskPartSchema>;
export type TaskSet=z.infer<typeof TaskSetSchema>;
export type FieldAnswer=z.infer<typeof FieldAnswerSchema>;
export type AnswerSet=z.infer<typeof AnswerSetSchema>;
export type FieldGrouping=z.infer<typeof FieldGroupingSchema>;
export type SubmitPayload=z.infer<typeof SubmitPayloadSchema>;
export type RunSummary=z.infer<typeof RunSummarySchema>;
export type RunView=z.infer<typeof RunViewSchema>;
export type BrowserStatus=z.infer<typeof BrowserStatusSchema>;
export type Me=z.infer<typeof MeSchema>;
export type WorkerCommand=z.infer<typeof WorkerCommandSchema>;
export type SubmitResult=z.infer<typeof SubmitResultSchema>;
