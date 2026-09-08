import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(256);
export const ApiErrorSchema = z.object({ code: z.string(), message: z.string() }).strict();
export const OptionSchema = z.object({ id: identifier, label: z.string().min(1).max(2048) }).strict();
export const MediaAssetSchema = z.object({
  id: identifier,
  kind: z.enum(['image', 'audio']),
  mimeType: z.string().min(1).max(128),
  byteLength: z.number().int().positive().max(20 * 1024 * 1024),
  sha256: hash,
  durationMs: z.number().int().positive().max(120_000).optional(),
}).strict();
export const InstructionBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1) }).strict(),
  z.object({ type: z.literal('image'), asset: MediaAssetSchema, caption: z.string().optional() }).strict(),
  z.object({ type: z.literal('audio'), asset: MediaAssetSchema, caption: z.string().optional() }).strict(),
]);
export const InstructionBundleSchema = z.object({
  sourceKey: identifier, hash, blocks: z.array(InstructionBlockSchema).min(1).max(256),
}).strict();
export const TaskSnapshotSchema = z.object({
  projectId: identifier,
  taskId: identifier,
  question: z.string(),
  instruction: InstructionBundleSchema,
  image: MediaAssetSchema.nullable(),
  audio: MediaAssetSchema.nullable(),
  options: z.array(OptionSchema).min(2).max(10),
  snapshotHash: hash,
  expiresAt: z.iso.datetime().nullable(),
  adapterVersion: identifier,
}).strict();
export const DecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('ANSWER'), optionId: identifier }).strict(),
  z.object({ decision: z.literal('ABSTAIN') }).strict(),
]);
export const ReviewTaskSchema = TaskSnapshotSchema.extend({
  proposal: DecisionSchema.nullable(),
  aiError: ApiErrorSchema.nullable(),
  confirmationNonce: identifier,
});
export const RunStatusSchema = z.enum(['PREPARING', 'ANALYZING', 'AWAITING_CONFIRMATION', 'SUBMITTING', 'COMPLETED', 'STOPPED', 'INTERRUPTED', 'UNKNOWN', 'FAILED']);
export const RunItemResultSchema = z.object({
  taskId: identifier, ordinal: z.number().int().positive(),
  status: z.enum(['DRAFT', 'SUBMIT_INTENT', 'SUBMITTED', 'UNKNOWN', 'FAILED']),
  optionId: z.string().nullable(), code: z.string().nullable(), createdAt: z.iso.datetime(),
}).strict();
export const RunSummarySchema = z.object({
  id: z.uuid(), status: RunStatusSchema, maxTasks: z.number().int().min(1).max(50),
  processed: z.number().int().min(0).max(50), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  error: ApiErrorSchema.nullable(),
}).strict();
export const RunViewSchema = RunSummarySchema.extend({current: ReviewTaskSchema.nullable(), results: z.array(RunItemResultSchema)});
export const BrowserStatusSchema = z.object({
  workerId: identifier, generation: z.string().nullable(), mode: z.enum(['CLOSED', 'IDLE', 'MANUAL', 'AUTOMATION']),
  url: z.string().nullable(), runId: z.string().nullable(),
}).strict();
export const MeSchema = z.object({
  id: z.uuid(), login: z.string(),
  quota: z.object({limit:z.number().int(),used:z.number().int(),remaining:z.number().int(),resetsAt:z.iso.datetime()}).strict(),
}).strict();
export const WorkerCommandSchema = z.object({
  id: z.uuid(), type: z.enum(['OPEN','ENTER_MANUAL','EXIT_MANUAL','BEGIN','SNAPSHOT','SUBMIT','STOP','CLOSE']),
  generation: z.string().optional(), runId: z.string().optional(),
  payload: z.object({taskId:identifier,snapshotHash:hash,instructionHash:hash,optionId:identifier}).strict().optional(),
}).strict();
export const SubmitResultSchema = z.object({
  outcome: z.enum(['SUBMITTED','COMPLETE','UNKNOWN','REJECTED']), nextTaskId: z.string().optional(), code: z.string().optional(),
}).strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type MediaAsset = z.infer<typeof MediaAssetSchema>;
export type InstructionBlock = z.infer<typeof InstructionBlockSchema>;
export type InstructionBundle = z.infer<typeof InstructionBundleSchema>;
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type ReviewTask = z.infer<typeof ReviewTaskSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type RunView = z.infer<typeof RunViewSchema>;
export type BrowserStatus = z.infer<typeof BrowserStatusSchema>;
export type Me = z.infer<typeof MeSchema>;
export type WorkerCommand = z.infer<typeof WorkerCommandSchema>;
export type SubmitResult = z.infer<typeof SubmitResultSchema>;
