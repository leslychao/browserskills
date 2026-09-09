import { describe, expect, it } from 'vitest';
import { AnswerSetSchema, CatalogueSchema, SelectionSettingsSchema, TaskSetSchema, WorkerCommandSchema, defaultSelection, validateAnswers } from '../src/index.js';

const hash='a'.repeat(64);
const task={poolId:'12',suiteId:'34',parts:[{id:'p1',title:'Example',text:'Choose',media:[],unmappedControls:[],fields:[
  {id:'f1',label:'Choice',kind:'SINGLE_CHOICE',required:true,options:[{id:'a',label:'A'},{id:'b',label:'B'}],value:null,stage:0,maxLength:null,min:null,max:null},
  {id:'f2',label:'Count',kind:'NUMBER',required:true,options:[],value:null,stage:1,maxLength:null,min:0,max:5},
]}],instruction:{sourceKey:'pool:12',hash,blocks:[{id:'i1',type:'text',text:'Choose one.'}]},snapshotHash:hash,expiresAt:null,adapterVersion:'yang-v2'};

describe('whole Yang task contracts',()=>{
  it('accepts a complete typed set and scoped partial staged answers',()=>{
    const parsed=TaskSetSchema.parse(task);
    expect(validateAnswers(parsed,[{partId:'p1',fieldId:'f1',value:'a'}],false)).toEqual([]);
    expect(validateAnswers(parsed,[{partId:'p1',fieldId:'f1',value:'a'},{partId:'p1',fieldId:'f2',value:3}],true)).toEqual([]);
  });
  it('rejects missing required, wrong values and duplicate field answers',()=>{
    const parsed=TaskSetSchema.parse(task);
    expect(validateAnswers(parsed,[],true)).toContain('MISSING_REQUIRED_FIELD');
    expect(validateAnswers(parsed,[{partId:'p1',fieldId:'f1',value:'c'}],false)).toContain('INVALID_FIELD_VALUE');
    expect(validateAnswers(parsed,[{partId:'p1',fieldId:'f2',value:6}],false)).toContain('INVALID_FIELD_VALUE');
    expect(validateAnswers(parsed,[{partId:'p1',fieldId:'f1',value:'a'},{partId:'p1',fieldId:'f1',value:'b'}],false)).toContain('DUPLICATE_FIELD_ANSWER');
  });
  it('rejects duplicate parts and legacy single option payloads',()=>{
    expect(TaskSetSchema.safeParse({...task,parts:[task.parts[0],task.parts[0]]}).success).toBe(false);
    expect(AnswerSetSchema.safeParse({decision:'ANSWER',optionId:'a'}).success).toBe(false);
    expect(WorkerCommandSchema.safeParse({id:crypto.randomUUID(),type:'SUBMIT',payload:{taskId:'34',optionId:'a',snapshotHash:hash,instructionHash:hash}}).success).toBe(false);
  });
  it('preserves explicit selection and rejects conflicting filters',()=>{
    expect(SelectionSettingsSchema.parse(defaultSelection()).mode).toBe('MANUAL');
    expect(SelectionSettingsSchema.safeParse({...defaultSelection(),includePoolIds:['1'],excludePoolIds:['1']}).success).toBe(false);
    expect(SelectionSettingsSchema.safeParse({...defaultSelection(),minReward:'NaN'}).success).toBe(false);
  });
  it('checks text, multiple choice, unknown ids and unmapped controls before submission',()=>{
    const parsed=TaskSetSchema.parse(task);
    parsed.parts[0].fields.push(
      {...parsed.parts[0].fields[0],id:'multi',kind:'MULTI_CHOICE'},
      {...parsed.parts[0].fields[0],id:'text',kind:'TEXT',options:[],maxLength:4},
    );
    const answers=[{partId:'p1',fieldId:'multi',value:['a','b']},{partId:'p1',fieldId:'text',value:'test'}];
    expect(validateAnswers(parsed,answers,false)).toEqual([]);
    for(const value of [['a','a'],[],['unknown']])expect(validateAnswers(parsed,[{partId:'p1',fieldId:'multi',value}],false)).toContain('INVALID_FIELD_VALUE');
    for(const value of ['','longer',3])expect(validateAnswers(parsed,[{partId:'p1',fieldId:'text',value}],false)).toContain('INVALID_FIELD_VALUE');
    expect(validateAnswers(parsed,[{partId:'other',fieldId:'text',value:'a'}],false)).toContain('UNKNOWN_FIELD');
    parsed.parts[0].unmappedControls.push({id:'opaque',label:'?',context:'unknown',selected:null});
    expect(validateAnswers(parsed,[],true)).toContain('UNMAPPED_CONTROLS');
    parsed.parts[0].fields=parsed.parts[0].fields.map(f=>({...f,required:false,maxLength:null,min:null,max:null}));
    expect(validateAnswers(parsed,[{partId:'p1',fieldId:'multi',value:[]},{partId:'p1',fieldId:'text',value:''},{partId:'p1',fieldId:'f2',value:-50}],false)).toEqual([]);
  });
  it('validates answered model output and does not confuse catalogue identity',()=>{
    expect(AnswerSetSchema.parse({decision:'ANSWER',answers:[{partId:'p1',fieldId:'f1',value:'a'}],reason:null}).decision).toBe('ANSWER');
    expect(AnswerSetSchema.parse({decision:'ABSTAIN',answers:[],reason:'Unclear'}).decision).toBe('ABSTAIN');
    expect(AnswerSetSchema.safeParse({decision:'ABSTAIN',answers:[{partId:'p1',fieldId:'f1',value:'a'}],reason:null}).success).toBe(false);
    const item={poolId:'12',title:'Task',reward:{amount:'15.00',unit:'за задание'},availability:'AVAILABLE',kind:'WORK',modalities:['audio'],preparation:'UNPREPARED',reason:null};
    expect(CatalogueSchema.safeParse({items:[item],refreshedAt:null,activePoolId:null,activeSuiteId:null}).success).toBe(true);
    expect(CatalogueSchema.safeParse({items:[item,item],refreshedAt:null,activePoolId:null,activeSuiteId:null}).success).toBe(false);
    const withMedia=structuredClone(task);
    const asset={id:'sound',kind:'audio',mimeType:'audio/wav',byteLength:100,sha256:hash,durationMs:60000};
    expect(TaskSetSchema.safeParse({...withMedia,parts:[{...withMedia.parts[0],media:[asset]}]}).success).toBe(true);
    expect(TaskSetSchema.safeParse({...withMedia,parts:[{...withMedia.parts[0],media:[{...asset,durationMs:60001}]}]}).success).toBe(false);
  });
});
