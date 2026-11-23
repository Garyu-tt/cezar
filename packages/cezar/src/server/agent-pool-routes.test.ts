import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { agentPoolStatusSchema, runRecordSchema } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

describe('native pool API creates ordinary Cezar tasks', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedDry = process.env.CEZ_DRY_RUN;
  let home: string;
  let repo: string;
  let store: RunStore;
  let app: Hono;
  let launches: number;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-pool-home-'));
    repo = mkdtempSync(join(tmpdir(), 'cez-pool-repo-'));
    mkdirSync(join(repo, '.ai', 'cezar'), { recursive: true });
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    launches = 0;
    store = RunStore.open(join(repo, '.ai', 'cezar'), { keepLive: true });
    const manager = {
      startRun: (workflow: { name: string }, input: { task: string }) => {
        launches += 1;
        return store.createRun({
          title: input.task.slice(0, 120),
          task: input.task,
          workflow: workflow.name,
          steps: [],
        });
      },
      isActive: () => false,
    } as unknown as RunManager;
    app = createApp({
      repoRoot: repo,
      store,
      manager,
      version: '0.21.0-native-pool-test',
      onDispose: (dispose) => cleanups.push(dispose),
      semaphore: { projectMaxParallel: () => 17 } as unknown as WorkspaceSemaphore,
    });
  });

  afterEach(() => {
    for (const dispose of cleanups.splice(0)) dispose();
    store.flush();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedDry === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDry;
  });

  const request = (url: string, method = 'GET', body?: unknown) =>
    apiRequest(app, '/api/v1' + url, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });

  it('scales 0 → 17 and shows 17 native runs under the existing Tasks list', async () => {
    const initial = await request('/agent-pool');
    expect(initial.status).toBe(200);
    expect(agentPoolStatusSchema.parse(await initial.json()).desired).toBe(0);
    const jobs = Array.from({ length: 17 }, (_, i) => ({
      id: 'job-' + i,
      task: 'Add a deterministic regression test for existing issue ' + i,
      role: 'test',
      readOnly: true,
    }));
    const staged = await request('/agent-pool/jobs', 'POST', { jobs });
    expect(staged.status).toBe(201);
    expect(agentPoolStatusSchema.parse(await staged.json()).waiting).toBe(17);
    expect(launches).toBe(0);

    const scale = await request('/agent-pool', 'PUT', { desired: 17 });
    expect(scale.status).toBe(200);
    const result = agentPoolStatusSchema.parse(await scale.json());
    expect(result.desired).toBe(17);
    expect(result.resourceCap).toBe(17);
    expect(result.jobs).toHaveLength(17);
    expect(result.jobs.every((job: { runId?: string }) => !!job.runId)).toBe(true);
    expect(launches).toBe(17);

    const native = await request('/runs');
    expect(native.status).toBe(200);
    const records = runRecordSchema.array().parse(await native.json());
    expect(records).toHaveLength(17);
    expect(records[0]?.task).toMatch(/^\[CEZ-POOL:job-/);

    const alias = await request('/p/default/agent-pool');
    expect(alias.status).toBe(200);
    expect(agentPoolStatusSchema.parse(await alias.json()).jobs).toHaveLength(17);
  });

  it('fails closed for graph-owned native jobs until server-side routing is wired', async () => {
    expect((await request('/agent-pool', 'PUT', { desired: 2 })).status).toBe(200);
    const protectedJob = {
      id: 'mojum-build-1',
      task: 'Implement and test a scoped cross-repository feature for Mojum',
      role: 'integration', readOnly: false, logicalProjectId: 'mojum',
    };
    const staged = await request('/agent-pool/jobs', 'POST', { jobs: [protectedJob] });
    expect(staged.status).toBe(201);
    const blocked = agentPoolStatusSchema.parse(await staged.json());
    expect(blocked.jobs[0]).toMatchObject({
      id: 'mojum-build-1', logicalProjectId: 'mojum', state: 'pending',
      admissionBlock: 'graph-admission-unavailable',
    });
    expect(blocked.blocked).toBe(1);
    expect(store.listRuns()).toHaveLength(0);
    expect(launches).toBe(0);

    const ordinary = await request('/agent-pool/jobs', 'POST', { jobs: [{
      id: 'independent-build-1',
      task: 'Add and test an isolated regression fix in this existing repository',
      role: 'test', readOnly: true,
    }] });
    expect(ordinary.status).toBe(201);
    expect(agentPoolStatusSchema.parse(await ordinary.json()).jobs[1]?.state).toBe('launched');
    expect(store.listRuns()).toHaveLength(1);
    expect(launches).toBe(1);
  });

  it('rejects bad scaling and duplicate work without launching any tasks', async () => {
    expect((await request('/agent-pool', 'PUT', { desired: 501 })).status).toBe(400);
    expect((await request('/agent-pool', 'PUT', { desired: -1 })).status).toBe(400);
    const one = {
      id: 'job-safe',
      task: 'Read-only inspect a file to identify a regression.',
      role: 'review', readOnly: true,
    };
    expect((await request('/agent-pool/jobs', 'POST', { jobs: [one] })).status).toBe(201);
    expect((await request('/agent-pool/jobs', 'POST', {
      jobs: [{ ...one, task: 'Alter the previous work identity to cause conflict.' }],
    })).status).toBe(409);
    expect(launches).toBe(0);
    expect(store.listRuns()).toHaveLength(0);
  });
});
