/** Standalone integration fixture. Never imported by production main or Docker ENTRYPOINT. */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { BrowserOwner } from '../../apps/browser/src/owner.js';
import { createWorkerServer } from '../../apps/browser/src/server.js';
import { fixtureProfile } from '../../apps/browser/test/fixture-profile.js';
import { startTestSite, type FixtureMode } from './server.js';

const directory=resolve(process.env.FIXTURE_DATA_DIR??'.cache/integration-worker');await mkdir(directory,{recursive:true});
const fixture=await startTestSite((process.env.FIXTURE_MODE??'normal') as FixtureMode);
const owner=new BrowserOwner({workerId:process.env.FIXTURE_WORKER_ID??'browser-1',profileDir:join(directory,'profile'),mediaDir:join(directory,'media'),headless:process.env.FIXTURE_HEADLESS!=='false',startUrl:fixture.url,profiles:[fixtureProfile(fixture.url)],verificationTimeoutMs:500});
const token=process.env.FIXTURE_WORKER_TOKEN??'fixture-only-token-not-a-production-secret-123456789';
const application=createWorkerServer(owner,token);
application.server.listen(Number(process.env.FIXTURE_WORKER_PORT??3301),process.env.FIXTURE_BIND_ADDRESS??'127.0.0.1');await once(application.server,'listening');
// Only URLs/port and the fixture label, never bearer credentials or task materials.
process.stdout.write(JSON.stringify({fixture:true,port:(application.server.address() as import('node:net').AddressInfo).port,siteUrl:fixture.url})+'\n');
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void application.close().then(()=>fixture.close()).then(()=>process.exit(0));});
