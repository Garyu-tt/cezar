/**
 * Safe, READ-ONLY cross-repository execution preview.
 *
 * Input is the native workspace graph and status-probed registered projects.
 * This module neither schedules agents nor checks out repositories. The
 * caller's project-scoped authorization and the host-wide resource semaphore
 * remain authoritative at actual dispatch time.
 *
 * Global waves include independent projects even when the focus project's
 * dependency chain is blocked; this avoids one bad repository freezing an
 * otherwise unrelated portfolio.
 */
import type { ProjectListEntry } from './projects.ts';
import type { ProjectGraphSummary } from './project-graph.ts';
import { projectFocusScope } from './project-graph.ts';

export type ProjectPlanBlockReason =
  | 'missing-checkout'
  | 'not-git'
  | 'unresolved-dependency'
  | 'blocked-dependency'
  | 'cycle-or-dependent';

export interface ProjectPlanBlocked {
  id: string;
  reason: ProjectPlanBlockReason;
  blockedBy: string[];
}

export interface NativeProjectPlan {
  focusProjectId: string | null;
  focusScope: string[];
  /** Independent registered projects ordered in dependency-first waves. */
  waves: string[][];
  /** Explicit reasons, never silently skip a dependency or a missing checkout. */
  blocked: ProjectPlanBlocked[];
  /** Listed for auditing; unregistered consumers cannot be scheduled. */
  unresolvedLinks: ProjectGraphSummary['unresolvedLinks'];
  /** Advisory planning only, NOT a permit to start, merge, or bill anything. */
  previewOnly: true;
}

const isPrerequisite = (type: string) =>
  type === 'part-of' || type === 'built-on' || type === 'depends-on' || type === 'provides-feature';

function consumerAndProvider(link: { from: string; to: string; type: string }): [string, string] {
  return link.type === 'provides-feature'
    ? [link.to, link.from]
    : [link.from, link.to];
}

export function previewNativeProjectPlan(
  graph: ProjectGraphSummary,
  projects: readonly Pick<ProjectListEntry, 'id' | 'status'>[],
): NativeProjectPlan {
  const ids = new Set(graph.projectIds);
  const status = new Map(projects.map((project) => [project.id, project.status]));
  const prerequisites = new Map(graph.projectIds.map((id) => [id, new Set<string>()]));
  const blocked = new Map<string, ProjectPlanBlocked>();

  function mark(id: string, reason: ProjectPlanBlockReason, dependencies: string[] = []): void {
    // Keep the primary root cause for predictable diagnostics, but merge
    // multiple missing/unresolved dependencies without losing their names.
    const existing = blocked.get(id);
    if (existing) {
      if (existing.reason === reason)
        existing.blockedBy = [...new Set([...existing.blockedBy, ...dependencies])].sort();
      return;
    }
    blocked.set(id, { id, reason, blockedBy: [...new Set(dependencies)].sort() });
  }

  for (const id of graph.projectIds) {
    const state = status.get(id);
    if (state === 'missing' || state === undefined) mark(id, 'missing-checkout');
    else if (state === 'not-git') mark(id, 'not-git');
  }

  for (const link of graph.links) {
    if (!isPrerequisite(link.type)) continue;
    const [consumer, provider] = consumerAndProvider(link);
    if (consumer !== provider && ids.has(consumer) && ids.has(provider))
      prerequisites.get(consumer)!.add(provider);
    else if (ids.has(consumer)) mark(consumer, 'unresolved-dependency', [provider]);
  }

  // A hand-edited registry may contain stale cross-repo links. Never treat
  // absence of the missing provider as permission to execute a consumer.
  for (const link of graph.unresolvedLinks) {
    if (!isPrerequisite(link.type)) continue;
    const [consumer, provider] = consumerAndProvider(link);
    if (ids.has(consumer)) mark(consumer, 'unresolved-dependency', [provider]);
  }

  // Block consumers of missing or already-blocked dependencies, transitively.
  // Iterate in deterministic registered ID order until a fixed point.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of graph.projectIds) {
      if (blocked.has(id)) continue;
      const missing = [...prerequisites.get(id)!].filter((prerequisite) => blocked.has(prerequisite));
      if (missing.length > 0) {
        mark(id, 'blocked-dependency', missing);
        changed = true;
      }
    }
  }

  const remaining = new Set(graph.projectIds.filter((id) => !blocked.has(id)));
  const waves: string[][] = [];

  // Kahn's algorithm handles independent components separately, so a cycle
  // in one subgraph does not suppress unrelated work.
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) =>
      [...prerequisites.get(id)!].every((provider) => !remaining.has(provider))).sort();
    if (ready.length === 0) break;
    waves.push(ready);
    for (const id of ready) remaining.delete(id);
  }

  for (const id of remaining) {
    const stillBlockedBy = [...prerequisites.get(id)!].filter((provider) => remaining.has(provider)).sort();
    mark(id, 'cycle-or-dependent', stillBlockedBy);
  }

  return {
    focusProjectId: graph.focusProjectId,
    focusScope: graph.focusProjectId && ids.has(graph.focusProjectId)
      ? projectFocusScope(graph) : [],
    waves,
    blocked: [...blocked.values()].sort((a, b) => a.id.localeCompare(b.id)),
    unresolvedLinks: graph.unresolvedLinks,
    previewOnly: true,
  };
}
