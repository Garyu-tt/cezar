/**
 * Side-effect-free logical-product -> execution-checkout routing preflight.
 *
 * A "logical" product represents the owning workstream (e.g. Mojum). The
 * execution project is the ONE registered Cezar checkout that would own an
 * agent run, git worktree and PR. This is NOT an agent dispatcher, authorization
 * gate or an account/project clone command: actual submission must pass through
 * the native project-scoped agent-pool endpoint with its normal approval,
 * provider and capacity checks.
 *
 * The strict membership rule prevents a logical Mojum request from quietly
 * executing in an unrelated repository, even if that repository is healthy.
 * Independent work remains possible under its own logical project ID.
 */
import type { ProjectGraphSummary } from './project-graph.ts';
import { projectFocusScope } from './project-graph.ts';
import type { NativeProjectPlan } from './project-graph-planner.ts';

export const ROUTING_REFUSALS = [
  'unknown-logical-project',
  'unknown-execution-project',
  'outside-logical-scope',
  'execution-blocked',
] as const;

export type ProjectRoutingRefusal = (typeof ROUTING_REFUSALS)[number];

export interface ProjectRoutePreview {
  logicalProjectId: string;
  executionProjectId: string;
  eligible: boolean;
  reason: 'ready' | ProjectRoutingRefusal;
  /** Real project-scoped Cezar native pool endpoint, never a remote GitHub URL. */
  nativePoolEndpoint: string | null;
  /** The reason why the checkout is unavailable, for operator inspection. */
  blockedReason: NativeProjectPlan['blocked'][number]['reason'] | null;
  blockedBy: string[];
  /** Product membership gives scope, never grants permission to execute work. */
  logicalScope: string[];
  previewOnly: true;
}

const safeProjectId = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Be intentionally conservative about inconsistent snapshots: a mismatch
 * between plan and graph results in NOT eligible, not an optimistic dispatch.
 */
export function previewProjectRouting(
  graph: ProjectGraphSummary,
  plan: NativeProjectPlan,
  logicalProjectId: string,
  executionProjectId: string,
): ProjectRoutePreview {
  const ids = new Set(graph.projectIds);
  const logicalKnown = safeProjectId.test(logicalProjectId) && ids.has(logicalProjectId);
  const executionKnown = safeProjectId.test(executionProjectId) && ids.has(executionProjectId);
  const scope = logicalKnown ? projectFocusScope(graph, logicalProjectId) : [];
  const reason: ProjectRoutePreview['reason'] = !logicalKnown
    ? 'unknown-logical-project'
    : !executionKnown
      ? 'unknown-execution-project'
      : !scope.includes(executionProjectId)
        ? 'outside-logical-scope'
        : plan.blocked.some((item) => item.id === executionProjectId)
          ? 'execution-blocked'
          : plan.waves.some((wave) => wave.includes(executionProjectId))
            ? 'ready'
            : 'execution-blocked';

  const state = plan.blocked.find((item) => item.id === executionProjectId);
  return {
    logicalProjectId,
    executionProjectId,
    eligible: reason === 'ready',
    reason,
    nativePoolEndpoint: reason === 'ready'
      ? `/api/v1/p/${executionProjectId}/agent-pool/jobs` : null,
    blockedReason: state?.reason ?? null,
    blockedBy: state?.blockedBy ?? [],
    logicalScope: scope,
    previewOnly: true,
  };
}
