import { afterEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startTestSite, type FixtureMode } from '../../../tests/test-site/server.js';
import { FixedAdapter } from '../src/adapter.js';
import { MediaStore } from '../src/media.js';
import { fixtureProfile } from './fixture-profile.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function setup(mode: FixtureMode = 'normal') {
  const site = await startTestSite(mode); cleanup.push(site.close);
  const directory = await mkdtemp(join(tmpdir(), 'browserskills-adapter-')); cleanup.push(() => rm(directory, {recursive:true,force:true}));
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true }); cleanup.push(() => browser.close());
  const context = await browser.newContext({acceptDownloads:false});
  const page = await context.newPage(); await page.goto(site.url);
  const store = new MediaStore(directory); cleanup.push(() => store.clear());
  const adapter = new FixedAdapter(page, store, [fixtureProfile(site.url)], {verificationTimeoutMs:300});
  return {site,page,store,adapter};
}

describe('real Chromium submission unit and identity', () => {
  it('sends fifty distinct tasks exactly once each', async () => {
    const {site,adapter} = await setup();
    for (let i=1;i<=50;i++) {
      const snapshot = await adapter.snapshot();
      expect(snapshot.taskId).toBe(`task-${i}`);
      const result = await adapter.submit({taskId:snapshot.taskId,snapshotHash:snapshot.snapshotHash,instructionHash:snapshot.instruction.hash,optionId:snapshot.options[0]!.id});
      expect(result.outcome).toBe('SUBMITTED');
    }
    expect(site.state.submissions).toHaveLength(50);
    expect(new Set(site.state.submissions.map(s=>s.taskId)).size).toBe(50);
  }, 90_000);
  it('does not conflate identical content and distinct task identities', async () => {
    const {adapter} = await setup('identical'); const first=await adapter.snapshot();
    await adapter.submit({taskId:first.taskId,snapshotHash:first.snapshotHash,instructionHash:first.instruction.hash,optionId:first.options[0]!.id});
    const second=await adapter.snapshot(); expect(second.taskId).not.toBe(first.taskId); expect(second.question).toBe(first.question);
  });
  it.each(['instruction','task','rerender'] as const)('rejects changed %s before click', async change => {
    const {adapter,page,site}=await setup(); const snapshot=await adapter.snapshot();
    await page.evaluate(change => {
      if(change==='instruction') document.querySelector('#instructions')!.textContent='Changed rules';
      if(change==='task') document.querySelector('#task')!.setAttribute('data-task-id','replacement');
      if(change==='rerender') { const old=document.querySelector('#task')!; old.replaceWith(old.cloneNode(true)); }
    }, change);
    await expect(adapter.submit({taskId:snapshot.taskId,snapshotHash:snapshot.snapshotHash,instructionHash:snapshot.instruction.hash,optionId:snapshot.options[0]!.id})).rejects.toMatchObject({code:'STALE_TASK'});
    expect(site.state.submissions).toHaveLength(0);
  });
  it.each(['multi','no-instruction','unsupported-link'] as const)('blocks incomplete or unsupported %s tasks', async mode => {
    const {adapter}=await setup(mode); await expect(adapter.snapshot()).rejects.toHaveProperty('code');
  });
  it.each(['lost','stale-success'] as const)('preserves uncertainty after %s', async mode => {
    const {adapter,site}=await setup(mode); const snapshot=await adapter.snapshot(); const payload={taskId:snapshot.taskId,snapshotHash:snapshot.snapshotHash,instructionHash:snapshot.instruction.hash,optionId:snapshot.options[0]!.id};
    expect((await adapter.submit(payload)).outcome).toBe('UNKNOWN');
    await expect(adapter.submit(payload)).rejects.toMatchObject({code:'ALREADY_ATTEMPTED'});
    expect(site.state.submissions).toHaveLength(1);
  });
  it('validation errors dominate success and never count as submitted', async () => {
    const {adapter,page,site}=await setup('reject'); const snapshot=await adapter.snapshot();
    await page.locator('#success').evaluate(el => (el as HTMLElement).hidden=false);
    expect((await adapter.submit({taskId:snapshot.taskId,snapshotHash:snapshot.snapshotHash,instructionHash:snapshot.instruction.hash,optionId:snapshot.options[0]!.id})).outcome).toBe('REJECTED');
    expect(site.state.submissions).toHaveLength(0);
  });
  it('production registry cannot treat the fixture as a verified Yandex template', async () => {
    const {page,store}=await setup(); await expect(new FixedAdapter(page,store).snapshot()).rejects.toMatchObject({code:'UNSUPPORTED_ORIGIN'});
  });
  it('does not submit when selecting the answer replaces the active task',async()=>{
    const {adapter,site}=await setup('swap-on-select');const snapshot=await adapter.snapshot();
    await expect(adapter.submit({taskId:snapshot.taskId,snapshotHash:snapshot.snapshotHash,instructionHash:snapshot.instruction.hash,optionId:snapshot.options[0]!.id})).rejects.toMatchObject({code:'STALE_TASK'});
    expect(site.state.submissions).toHaveLength(0);
  });
  it('binds a single explicitly allowed iframe and invalidates replaced frames',async()=>{
    const {page,store,site}=await setup();const child=await startTestSite();cleanup.push(child.close);
    await page.setContent(`<iframe id="task-frame" src="${child.url}"></iframe>`);
    await page.frameLocator('#task-frame').locator('#task').waitFor();
    const profile={...fixtureProfile(site.url),frame:{selector:'#task-frame',origin:child.url},mediaOrigins:[child.url]};
    const adapter=new FixedAdapter(page,store,[profile]);const snapshot=await adapter.snapshot();expect(snapshot.taskId).toBe('task-1');
    await page.locator('#task-frame').evaluate(frame=>frame.replaceWith(frame.cloneNode(true)));
    await page.frameLocator('#task-frame').locator('#task').waitFor();
    await expect(adapter.submit({taskId:snapshot.taskId,snapshotHash:snapshot.snapshotHash,instructionHash:snapshot.instruction.hash,optionId:snapshot.options[0]!.id})).rejects.toMatchObject({code:'STALE_TASK'});
    expect(child.state.submissions).toHaveLength(0);
  });
  it('rejects an iframe origin not explicitly allowed by the fixed profile',async()=>{
    const {page,store,site}=await setup();const child=await startTestSite();cleanup.push(child.close);
    await page.setContent(`<iframe id="task-frame" src="${child.url}"></iframe>`);await page.frameLocator('#task-frame').locator('#task').waitFor();
    const adapter=new FixedAdapter(page,store,[{...fixtureProfile(site.url),frame:{selector:'#task-frame',origin:site.url}}]);
    await expect(adapter.snapshot()).rejects.toMatchObject({code:'UNSUPPORTED_TEMPLATE'});
  });
});
