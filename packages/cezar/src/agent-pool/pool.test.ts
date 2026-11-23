import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentPoolPreflightUnavailable, NativeAgentPool, nativePoolMarker, type NativePoolRun, type AgentPoolPorts } from './pool.ts';

const directories: string[] = [];
async function harness(cap = 17, admit?: AgentPoolPorts['admit']) {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-native-pool-test-'));
  directories.push(dir);
  const runs: NativePoolRun[] = [];
  const launched: Array<{ id: string; task: string; readOnly: boolean }> = [];
  let resourceLimit = cap;
  let failLaunch = false;
  const ports = {
    dataDir: dir,
    listRuns: () => runs,
    capacity: () => resourceLimit,
    ...(admit ? { admit } : {}),
    launch: (task: string, readOnly: boolean, _model?: string) => {
      if (failLaunch) throw new Error('provider unavailable');
      const id = 'native-' + (runs.length + 1);
      const active = runs.filter((run) => run.status === 'running').length;
      runs.push({ id, task, status: active < resourceLimit ? 'running' : 'queued' });
      launched.push({ id, task, readOnly });
      return id;
    },
  };
  return {
    pool: await NativeAgentPool.open(ports),
    ports, runs, launched, dir,
    setCapacity: (value: number) => { resourceLimit = value; },
    setProviderFailure: (value: boolean) => { failLaunch = value; },
  };
}
function jobs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'issue-' + (100 + i),
    task: 'Implement and verify test case for feature ' + (100 + i),
    role: (i % 2 ? 'test' : 'build') as 'build' | 'test',
    readOnly: i % 2 !== 0,
  }));
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('native dynamic agent pool', () => {
  it('creates zero runs by default and obeys native capacity without synthetic worker claims', async () => {
    const h = await harness(5);
    const queued = await h.pool.enqueue(jobs(20));
    expect(queued.desired).toBe(0);
    expect(queued.waiting).toBe(20);
    expect(h.launched).toHaveLength(0);
    const scaled = await h.pool.scale(17);
    expect(scaled.desired).toBe(17);
    expect(scaled.resourceCap).toBe(5);
    expect(h.launched).toHaveLength(17);
    expect(scaled.nativeActive).toBe(5);
    expect(scaled.waiting).toBe(15); // 12 native-queued + 3 not yet admitted
    expect(h.launched[0]?.task).toContain('[Agent 1/17');
    expect(h.launched[0]?.task).toContain(nativePoolMarker('issue-100'));
    expect(h.launched[1]?.readOnly).toBe(true);
    expect(h.launched[0]?.readOnly).toBe(false);
  });

  it('scales to all 17, refills completed native slots and supports dynamic up/down adjustment', async () => {
    const h = await harness(17);
    await h.pool.enqueue(jobs(22));
    await h.pool.scale(17);
    expect(h.launched).toHaveLength(17);
    expect(h.pool.status().nativeActive).toBe(17);
    h.runs[3]!.status = 'done';
    await h.pool.tick();
    expect(h.launched).toHaveLength(18);
    expect(h.pool.status().completed).toBe(1);
    expect(h.pool.status().nativeActive).toBe(17);
    expect(h.launched[17]!.task).toContain('[Agent 4/17');
    await h.pool.scale(5);
    await h.pool.enqueue(jobs(25));
    expect(h.launched).toHaveLength(18); // drain existing work, never cancel it
    for (const run of h.runs) run.status = 'done';
    await h.pool.tick();
    expect(h.launched).toHaveLength(23);
    await h.pool.scale(0);
    for (const run of h.runs) run.status = 'done';
    await h.pool.tick();
    expect(h.launched).toHaveLength(23);
  });

  it('makes duplicate work idempotent and rejects conflicting work before mutation', async () => {
    const h = await harness();
    await h.pool.enqueue(jobs(3));
    await h.pool.enqueue(jobs(3));
    expect(h.pool.status().jobs).toHaveLength(3);
    await expect(h.pool.enqueue([
      { id: 'issue-100', task: 'A different task for this id', role: 'build', readOnly: false },
    ])).rejects.toThrow('conflicts');
    expect(h.pool.status().jobs).toHaveLength(3);
    await expect(h.pool.enqueue([jobs(2)[0]!, jobs(2)[0]!])).rejects.toThrow('duplicate');
    expect(h.pool.status().jobs).toHaveLength(3);
  });

  it('recovers an interrupted launch from the native run store, never double-dispatches', async () => {
    const h = await harness();
    const task = jobs(1)[0]!;
    const record = {
      schema: 'cezar.agent-pool.v1',
      desired: 17,
      jobs: [{ ...task, state: 'launching', slot: 1 }],
    };
    await writeFile(join(h.dir, 'agent-pool-v1.json'), JSON.stringify(record), { mode: 0o600 });
    h.runs.push({
      id: 'surviving-native',
      status: 'running',
      task: nativePoolMarker(task.id) + '[Agent 1/17 · BUILD] ' + task.task,
    });
    const restarted = await NativeAgentPool.open(h.ports);
    expect(restarted.status().nativeActive).toBe(1);
    expect(restarted.status().jobs[0]?.runId).toBe('surviving-native');
    await restarted.tick();
    expect(h.launched).toHaveLength(0);
    expect(JSON.parse(await readFile(join(h.dir, 'agent-pool-v1.json'), 'utf8')).jobs[0].state).toBe('launched');
  });

  it('marks an unconfirmed crash as uncertain rather than starting a second run', async () => {
    const h = await harness();
    const task = jobs(1)[0]!;
    await writeFile(join(h.dir, 'agent-pool-v1.json'), JSON.stringify({
      schema: 'cezar.agent-pool.v1', desired: 17,
      jobs: [{ ...task, state: 'launching', slot: 1 }],
    }), { mode: 0o600 });
    const restarted = await NativeAgentPool.open(h.ports);
    await restarted.tick();
    expect(restarted.status().jobs[0]?.state).toBe('uncertain');
    expect(h.launched).toHaveLength(0);
  });

  it('leaves failed launches explicitly blocked, never invents completed runs', async () => {
    const h = await harness();
    await h.pool.enqueue(jobs(2));
    h.setProviderFailure(true);
    const state = await h.pool.scale(17);
    expect(state.nativeActive).toBe(0);
    expect(state.blocked).toBe(2);
    expect(state.completed).toBe(0);
    expect(h.launched).toHaveLength(0);
  });

  it('keeps work pending after preflight provider denial instead of losing it', async () => {
    const h = await harness();
    await h.pool.enqueue(jobs(1));
    let accessible = false;
    const original = h.ports.launch;
    h.ports.launch = (task, readOnly) => {
      if (!accessible) throw new AgentPoolPreflightUnavailable('account unavailable');
      return original(task, readOnly);
    };
    await h.pool.scale(17);
    expect(h.pool.status().jobs[0]?.state).toBe('pending');
    expect(h.launched).toHaveLength(0);
    accessible = true;
    await h.pool.tick();
    expect(h.launched).toHaveLength(1);
  });

  it('refuses graph-owned jobs without a server admission callback while serving unrelated jobs', async () => {
    const h = await harness(5);
    await h.pool.enqueue([
      { id: 'guarded', task: 'Implement Mojum feature in the explicitly assigned workspace', role: 'build',
        readOnly: false, logicalProjectId: 'mojum' },
      { id: 'ordinary', task: 'Fix an unrelated existing repository regression test', role: 'test', readOnly: true },
    ]);
    const result = await h.pool.scale(2);
    expect(h.launched).toHaveLength(1);
    expect(result.waiting).toBe(0);
    expect(result.blocked).toBe(1);
    expect(result.jobs.find((j) => j.id === 'guarded')).toMatchObject({
      state: 'pending', logicalProjectId: 'mojum',
      admissionBlock: 'graph-admission-unavailable',
    });
    expect(result.jobs.find((j) => j.id === 'ordinary')?.state).toBe('launched');
  });

  it('rechecks graph eligibility immediately before native launch, then resumes one job exactly once', async () => {
    let eligible = false;
    let checks = 0;
    const h = await harness(5, () => { checks++; return eligible; });
    await h.pool.enqueue([
      { id: 'planned', task: 'Implement the verified feature for the owner product Mojum',
        logicalProjectId: 'mojum', role: 'integration', readOnly: false },
    ]);
    // A client-side planning preview is NOT an admission signal.
    expect(h.launched).toHaveLength(0);
    expect((await h.pool.scale(2)).jobs[0]).toMatchObject({
      state: 'pending', admissionBlock: 'graph-route-refused', logicalProjectId: 'mojum',
    });
    expect(checks).toBe(1);
    expect(h.launched).toHaveLength(0);
    eligible = true;
    const allowed = await h.pool.tick();
    expect(h.launched).toHaveLength(1);
    expect(allowed.jobs[0]).toMatchObject({ state: 'launched', logicalProjectId: 'mojum' });
    expect(allowed.jobs[0]?.admissionBlock).toBeUndefined();
    await h.pool.tick();
    expect(h.launched).toHaveLength(1);
  });

  it('does not confuse a thrown graph gate with an uncertain run creation', async () => {
    const h = await harness(5, () => { throw new Error('private path must not be echoed'); });
    await h.pool.enqueue([
      { id: 'guarded', task: 'Review graph dependency before running a native task',
        logicalProjectId: 'mojum', role: 'review', readOnly: true },
    ]);
    const view = await h.pool.scale(1);
    expect(view.jobs[0]).toMatchObject({
      state: 'pending', admissionBlock: 'graph-admission-error',
    });
    expect(h.launched).toHaveLength(0);
    expect(JSON.stringify(view)).not.toContain('private path must not be echoed');
  });

  it('treats changing logical owner as idempotency conflict, never silently redirects execution', async () => {
    const h = await harness();
    const incoming = {
      id: 'same-job', task: 'Implement and test the same long-running cross-repo feature',
      role: 'build' as const, readOnly: false, logicalProjectId: 'mojum',
    };
    await h.pool.enqueue([incoming]);
    await expect(h.pool.enqueue([{ ...incoming, logicalProjectId: 'independent' }]))
      .rejects.toThrow('conflicts');
    expect(h.pool.status().jobs).toHaveLength(1);
    expect(h.pool.status().jobs[0]?.logicalProjectId).toBe('mojum');
  });

  it('routes 17 native Cezar tasks across weighted operator-selected models, with manual overrides', async () => {
    const h = await harness(17);
    const selected: Array<string | undefined> = [];
    const old = h.ports.launch;
    h.ports.launch = (task, readOnly, model) => {
      selected.push(model);
      return old(task, readOnly);
    };
    const work = jobs(17).map(job => ({ ...job, model: undefined as string | undefined }));
    work[2]!.model = 'local/override';
    await h.pool.enqueue(work);
    const view = await h.pool.scale(17, ['local/a', 'local/a', 'local/b', 'local/c']);
    expect(view.nativeActive).toBe(17);
    expect(view.models).toEqual(['local/a', 'local/a', 'local/b', 'local/c']);
    expect(selected).toHaveLength(17);
    expect(selected[0]).toBe('local/a');
    expect(selected[1]).toBe('local/a');
    expect(selected[2]).toBe('local/override');
    expect(selected[3]).toBe('local/c');
    expect(selected[4]).toBe('local/a');
    expect(view.jobs[2]?.model).toBe('local/override');
    await h.pool.scale(0, null);
    expect(h.pool.status().models).toEqual([]);
  });

  it('observes Cezar resource cap changes without a restart', async () => {
    const h = await harness(2);
    await h.pool.enqueue(jobs(17));
    await h.pool.scale(17);
    // The native Cezar scheduler queues all 17 records immediately.
    // Only 2 execute while the resource limit is 2; no phantom model calls.
    expect(h.launched).toHaveLength(17);
    expect(h.pool.status().nativeActive).toBe(2);
    expect(h.pool.status().waiting).toBe(15);
    h.setCapacity(10);
    for (const run of h.runs.slice(2, 10)) run.status = 'running';
    await h.pool.tick();
    expect(h.launched).toHaveLength(17); // already queued natively
    expect(h.pool.status().nativeActive).toBe(10);
    h.setCapacity(17);
    for (const run of h.runs) run.status = 'running';
    await h.pool.tick();
    expect(h.launched).toHaveLength(17);
    expect(h.pool.status().nativeActive).toBe(17);
    expect(h.pool.status().resourceCap).toBe(17);
  });
});
