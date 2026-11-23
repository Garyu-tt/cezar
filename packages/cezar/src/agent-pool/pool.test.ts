import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentPoolPreflightUnavailable, NativeAgentPool, nativePoolMarker, type NativePoolRun } from './pool.ts';

const directories: string[] = [];
async function harness(cap = 17) {
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
    launch: (task: string, readOnly: boolean) => {
      if (failLaunch) throw new Error('provider unavailable');
      const id = 'native-' + (runs.length + 1);
      runs.push({ id, task, status: 'running' });
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
    expect(h.launched).toHaveLength(5);
    expect(scaled.nativeActive).toBe(5);
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

  it('observes Cezar resource cap changes without a restart', async () => {
    const h = await harness(2);
    await h.pool.enqueue(jobs(17));
    await h.pool.scale(17);
    expect(h.launched).toHaveLength(2);
    h.setCapacity(10);
    await h.pool.tick();
    expect(h.launched).toHaveLength(10);
    h.setCapacity(17);
    await h.pool.tick();
    expect(h.launched).toHaveLength(17);
    expect(h.pool.status().resourceCap).toBe(17);
  });
});
