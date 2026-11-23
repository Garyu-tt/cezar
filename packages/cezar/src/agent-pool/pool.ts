import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  agentPoolJobInputSchema,
  type AgentPoolJobInput,
  type AgentPoolStatus,
} from '@open-mercato/cezar-contract';

/**
 * Native Cezar agent pool. No second runner, task database, HTTP server or UI.
 *
 * All work is launched through RunManager.startRun; the standard Cezar Tasks
 * screen and run history remain the only authority for actual activity.
 * The private manifest only records jobs waiting for a native run, and their
 * stable run IDs. Agent identities are leased dynamically; no fixed 300 cap.
 */
const storedJob = agentPoolJobInputSchema.extend({
  state: z.enum(['pending', 'launching', 'launched', 'uncertain', 'blocked']),
  selectedModel: z.string().optional(),
  runId: z.string().optional(),
  slot: z.number().int().positive().optional(),
});
const storedState = z.object({
  schema: z.literal('cezar.agent-pool.v1'),
  desired: z.number().int().min(0).max(500),
  models: z.array(z.string().min(3).max(200)).max(64).default([]),
  jobs: z.array(storedJob).max(5_000),
});
type State = z.infer<typeof storedState>;
type Job = State['jobs'][number];

export interface NativePoolRun {
  id: string;
  task: string;
  status: string;
}
export interface AgentPoolPorts {
  dataDir: string;
  /** Existing native RunManager, not a separate inference worker. */
  launch: (task: string, readOnly: boolean, model?: string) => string | Promise<string>;
  listRuns: () => NativePoolRun[];
  /** Existing Cezar workspace semaphore, refreshed when resource settings change. */
  capacity: () => number;
}

/** Safe to retry: the provider gate rejected work BEFORE a native run was created. */
export class AgentPoolPreflightUnavailable extends Error {}

const LIVE = new Set(['queued', 'running']);
export const nativePoolMarker = (id: string): string => '[CEZ-POOL:' + id + '] ';

function brief(task: string): string {
  return task.replace(/\s+/g, ' ').trim().slice(0, 115);
}

export class NativeAgentPool {
  private readonly path: string;
  private state: State = { schema: 'cezar.agent-pool.v1', desired: 0, models: [], jobs: [] };
  private chain: Promise<void> = Promise.resolve();

  private constructor(private readonly ports: AgentPoolPorts) {
    this.path = join(ports.dataDir, 'agent-pool-v1.json');
  }

  static async open(ports: AgentPoolPorts): Promise<NativeAgentPool> {
    const pool = new NativeAgentPool(ports);
    try {
      const details = await stat(pool.path);
      if (!details.isFile() || details.size > 2_000_000) throw new Error('unsafe agent pool manifest');
      pool.state = storedState.parse(JSON.parse(await readFile(pool.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // An interrupted native launch is uncertain, never blindly re-submitted.
    // Recover only when a native run's durable task has the same unique marker.
    const nativeRuns = ports.listRuns();
    let changed = false;
    for (const job of pool.state.jobs) {
      if (job.state !== 'launching') continue;
      const matching = nativeRuns.filter((run) => run.task.startsWith(nativePoolMarker(job.id)));
      if (matching.length === 1) {
        job.state = 'launched';
        job.runId = matching[0]!.id;
      } else {
        job.state = 'uncertain';
      }
      changed = true;
    }
    if (changed) await pool.save();
    return pool;
  }

  private async save(): Promise<void> {
    await mkdir(this.ports.dataDir, { recursive: true });
    const tmp = join(this.ports.dataDir, '.agent-pool-' + randomUUID() + '.tmp');
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(this.state) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try { await rename(tmp, this.path); }
    finally { await unlink(tmp).catch(() => {}); }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.then(() => {}, () => {});
    return result;
  }

  private capacity(): number {
    const value = this.ports.capacity();
    return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 500) : 0;
  }

  status(): AgentPoolStatus {
    const nativeRuns = new Map(this.ports.listRuns().map((run) => [run.id, run]));
    let nativeActive = 0;
    let waiting = 0;
    let completed = 0;
    let blocked = 0;
    const jobs = this.state.jobs.map((job) => {
      const run = job.runId ? nativeRuns.get(job.runId) : undefined;
      const nativeStatus = run?.status;
      if (nativeStatus === 'running') nativeActive += 1;
      if (job.state === 'pending' || nativeStatus === 'queued') waiting += 1;
      if (nativeStatus === 'done') completed += 1;
      if (job.state === 'blocked' || job.state === 'uncertain'
          || nativeStatus === 'failed' || nativeStatus === 'cancelled') blocked += 1;
      return {
        id: job.id,
        role: job.role,
        state: job.state,
        ...(job.runId ? { runId: job.runId } : {}),
        ...(nativeStatus ? { nativeStatus } : {}),
        ...(job.slot ? { slot: job.slot } : {}),
        title: brief(job.task),
        ...((job.selectedModel ?? job.model) ? { model: job.selectedModel ?? job.model } : {}),
      };
    });
    return {
      desired: this.state.desired,
      models: this.state.models,
      resourceCap: this.capacity(),
      nativeActive,
      waiting,
      completed,
      blocked,
      jobs,
    };
  }

  scale(desired: number, models?: string[] | null): Promise<AgentPoolStatus> {
    return this.serial(async () => {
      if (!Number.isSafeInteger(desired) || desired < 0 || desired > 500) throw new RangeError('desired must be 0..500');
      this.state.desired = desired;
      if (models !== undefined) {
        if (models !== null && (models.length < 1 || models.length > 64 || models.some(m =>
          typeof m !== 'string' || m.length < 3 || m.length > 200))) {
          throw new RangeError('invalid weighted model list');
        }
        this.state.models = models ?? [];
      }
      await this.save();
      await this.pumpUnsafe();
      return this.status();
    });
  }

  enqueue(incoming: AgentPoolJobInput[]): Promise<AgentPoolStatus> {
    return this.serial(async () => {
      if (!Array.isArray(incoming) || incoming.length < 1 || incoming.length > 100) throw new RangeError('1..100 jobs required');
      const proposed = incoming.map((item) => agentPoolJobInputSchema.parse(item));
      const newJobs: Job[] = [];
      const existing = new Map(this.state.jobs.map((job) => [job.id, job]));
      const inBatch = new Set<string>();
      for (const item of proposed) {
        if (inBatch.has(item.id)) throw new Error('duplicate pool job id');
        inBatch.add(item.id);
        const old = existing.get(item.id);
        if (old) {
          if (old.task !== item.task || old.role !== item.role || old.readOnly !== item.readOnly || old.model !== item.model) {
            throw new Error('pool job id conflicts with existing task');
          }
        } else {
          newJobs.push({ ...item, state: 'pending' });
        }
      }
      if (this.state.jobs.length + newJobs.length > 5_000) throw new RangeError('agent pool queue exhausted');
      this.state.jobs.push(...newJobs);
      await this.save();
      await this.pumpUnsafe();
      return this.status();
    });
  }

  tick(): Promise<AgentPoolStatus> {
    return this.serial(async () => {
      await this.pumpUnsafe();
      return this.status();
    });
  }

  private async pumpUnsafe(): Promise<void> {
    const resourceCap = this.capacity();
    const limit = Math.min(this.state.desired, resourceCap);
    if (limit <= 0) return;
    const runs = new Map(this.ports.listRuns().map((run) => [run.id, run]));
    const occupied = new Set<number>();
    let outstanding = 0;
    for (const job of this.state.jobs) {
      if (job.state !== 'launched') continue;
      const run = job.runId ? runs.get(job.runId) : undefined;
      if (run && LIVE.has(run.status)) {
        outstanding++;
        if (job.slot) occupied.add(job.slot);
      }
    }
    for (const job of this.state.jobs) {
      if (outstanding >= limit) break;
      if (job.state !== 'pending') continue;
      const slot = Array.from({ length: this.state.desired }, (_, i) => i + 1)
        .find((id) => !occupied.has(id));
      if (!slot) break;
      job.slot = slot;
      job.selectedModel = job.model ?? (this.state.models.length ? this.state.models[(slot - 1) % this.state.models.length] : undefined);
      job.state = 'launching';
      // Fenced first: a crash after launch cannot silently start a duplicate.
      await this.save();
      try {
        const nativeTask = nativePoolMarker(job.id) + '[Agent ' + slot + '/' + this.state.desired
          + ' · ' + job.role.toUpperCase() + '] ' + job.task;
        const runId = await this.ports.launch(nativeTask, job.readOnly, job.selectedModel);
        job.runId = runId;
        job.state = 'launched';
      } catch (error) {
        if (error instanceof AgentPoolPreflightUnavailable) {
          // No RunManager call occurred: a transient account/provider hold
          // must not burn or duplicate this job. Resume on the next tick.
          job.state = 'pending';
          job.slot = undefined;
          job.selectedModel = undefined;
          await this.save();
          break;
        }
        // An unknown launch exception may have occurred AFTER creating a run:
        // hold for operator inspection rather than retrying and double-running.
        job.state = 'uncertain';
      }
      await this.save();
      if (job.state === 'launched') {
        outstanding += 1;
        occupied.add(slot);
      }
    }
  }
}
