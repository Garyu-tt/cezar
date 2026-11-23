/**
 * Workspace-local, typed project relationships. This is an additive view over Cezar's
 * registered checkout IDs, not another checkout, repo registry, scheduler or Git history.
 *
 * The GitHub-wide catalog (.ai/ecosystem.json in the fork) includes remote/uncloned repos;
 * this graph is the execution-safe mapping of RELATIONSHIPS BETWEEN REGISTERED PROJECTS.
 * Linking a catalog entry to a checkout will be a separate, explicit resolution step.
 */
import {
  loadWorkspaceConfig,
  mergeWriteWorkspaceConfig,
  type ProjectRelation,
  type WorkspaceConfig,
} from './config.ts';

export const PROJECT_RELATION_TYPES = ['part-of', 'built-on', 'depends-on', 'provides-feature'] as const;
export type ProjectRelationType = (typeof PROJECT_RELATION_TYPES)[number];

const dependencyTypes: ReadonlySet<string> = new Set(['part-of', 'built-on', 'depends-on']);
const typeSet: ReadonlySet<string> = new Set(PROJECT_RELATION_TYPES);

export class ProjectGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectGraphError';
  }
}

const allIds = (config: WorkspaceConfig) => new Set(config.projects.map((p) => p.id));
const currentLinks = (config: WorkspaceConfig): ProjectRelation[] => config.projectGraph?.links ?? [];

function registered(config: WorkspaceConfig, id: string): void {
  if (!allIds(config).has(id)) throw new ProjectGraphError(`unknown registered project: ${id}`);
}

function assertLink(config: WorkspaceConfig, link: ProjectRelation): void {
  if (!typeSet.has(link.type)) throw new ProjectGraphError(`unknown project link type: ${link.type}`);
  registered(config, link.from);
  registered(config, link.to);
  if (link.from === link.to) throw new ProjectGraphError('a project cannot link to itself');

  const links = currentLinks(config);
  if (links.some((x) => x.from === link.from && x.to === link.to && x.type === link.type))
    throw new ProjectGraphError('project relationship already exists');

  if (link.type !== 'part-of') return;
  // A child can have one containment parent, but it can depend on many providers.
  if (links.some((x) => x.type === 'part-of' && x.from === link.from))
    throw new ProjectGraphError(`project ${link.from} already has a containment parent`);

  // Containment direction is CHILD -> PARENT. Traverse upward to reject cycles.
  const parent = new Map(links.filter((x) => x.type === 'part-of').map((x) => [x.from, x.to]));
  let node: string | undefined = link.to;
  const visited = new Set<string>();
  while (node !== undefined) {
    if (node === link.from) throw new ProjectGraphError('containment cycle');
    if (visited.has(node)) throw new ProjectGraphError('existing containment cycle');
    visited.add(node);
    node = parent.get(node);
  }
}

export async function linkRegisteredProjects(
  from: string, to: string, type: ProjectRelationType,
): Promise<ProjectRelation> {
  if (!typeSet.has(type)) throw new ProjectGraphError(`unknown project link type: ${type}`);
  const link: ProjectRelation = { from, to, type };
  await mergeWriteWorkspaceConfig((config) => {
    assertLink(config, link);
    config.projectGraph ??= { links: [] };
    config.projectGraph.links = [...(config.projectGraph.links ?? []), link];
  });
  return link;
}

export async function unlinkRegisteredProjects(
  from: string, to: string, type: ProjectRelationType,
): Promise<void> {
  await mergeWriteWorkspaceConfig((config) => {
    const links = currentLinks(config);
    const next = links.filter((x) => !(x.from === from && x.to === to && x.type === type));
    if (next.length === links.length) throw new ProjectGraphError('project relationship not found');
    config.projectGraph ??= { links: [] };
    config.projectGraph.links = next;
  });
}

/** Focus affects navigation and planning, not project containment or live agent queues. */
export async function focusRegisteredProject(id: string | null): Promise<void> {
  await mergeWriteWorkspaceConfig((config) => {
    if (id !== null) registered(config, id);
    config.projectGraph ??= { links: [] };
    if (id === null) delete config.projectGraph.focusProjectId;
    else config.projectGraph.focusProjectId = id;
  });
}

export interface ProjectGraphSummary {
  /** User's explicit focus if still registered, otherwise a safe first-project fallback. */
  focusProjectId: string | null;
  explicitFocusProjectId: string | null;
  projectIds: string[];
  /** References whose endpoints still exist in the registered workspace. */
  links: ProjectRelation[];
  /** Never silently erase links in an old config; allow repair or safe cleanup. */
  unresolvedLinks: ProjectRelation[];
}

export function projectGraphSummary(config: WorkspaceConfig): ProjectGraphSummary {
  const ids = allIds(config);
  const links = currentLinks(config);
  const selected = config.projectGraph?.focusProjectId ?? null;
  return {
    focusProjectId: selected !== null && ids.has(selected)
      ? selected : (config.projects[0]?.id ?? null),
    explicitFocusProjectId: selected,
    projectIds: config.projects.map((p) => p.id),
    links: links.filter((x) => ids.has(x.from) && ids.has(x.to)),
    unresolvedLinks: links.filter((x) => !ids.has(x.from) || !ids.has(x.to)),
  };
}

export async function readProjectGraph(): Promise<ProjectGraphSummary> {
  return projectGraphSummary(await loadWorkspaceConfig());
}

function traverse(start: string, edges: ReadonlyMap<string, readonly string[]>): string[] {
  const visited = new Set([start]);
  const pending = [start], result: string[] = [];
  while (pending.length) {
    const node = pending.shift()!;
    for (const next of edges.get(node) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      result.push(next);
      pending.push(next);
    }
  }
  return result;
}

function edgesOf(summary: ProjectGraphSummary, type: 'dependencies' | 'impact' | 'children'): Map<string, string[]> {
  const result = new Map(summary.projectIds.map((id) => [id, [] as string[]]));
  for (const link of summary.links) {
    if (type === 'children' && link.type !== 'part-of') continue;
    if (type !== 'children' && !dependencyTypes.has(link.type) && link.type !== 'provides-feature') continue;
    if (type === 'dependencies' && link.type === 'provides-feature') {
      // "provider -> consumer" is equivalent to "consumer depends on provider".
      result.get(link.to)!.push(link.from);
    } else if (type === 'impact' && link.type === 'provides-feature') {
      result.get(link.from)!.push(link.to);
    } else if (type === 'impact' || type === 'children') {
      result.get(link.to)!.push(link.from);
    } else {
      result.get(link.from)!.push(link.to);
    }
  }
  return result;
}

/** All prerequisites of a product, including reusable feature providers. */
export function projectDependencies(summary: ProjectGraphSummary, id: string): string[] {
  if (!summary.projectIds.includes(id)) throw new ProjectGraphError(`unknown registered project: ${id}`);
  return traverse(id, edgesOf(summary, 'dependencies'));
}

/** Projects that can be affected by updating id. */
export function projectImpact(summary: ProjectGraphSummary, id: string): string[] {
  if (!summary.projectIds.includes(id)) throw new ProjectGraphError(`unknown registered project: ${id}`);
  return traverse(id, edgesOf(summary, 'impact'));
}

/** Focus + contained children + prerequisites, never a filesystem traversal. */
export function projectFocusScope(summary: ProjectGraphSummary, id: string | null = summary.focusProjectId): string[] {
  if (id === null) return [];
  const children = traverse(id, edgesOf(summary, 'children'));
  const items = new Set([id, ...children]);
  for (const member of [...items]) for (const dependency of projectDependencies(summary, member)) items.add(dependency);
  return [...items];
}

/** Groups of registered repositories with no outstanding cross-repo prerequisites within each wave. */
export function projectExecutionWaves(summary: ProjectGraphSummary): string[][] {
  const prerequisites = new Map(summary.projectIds.map((id) => [id, new Set<string>()]));
  const consumers = new Map(summary.projectIds.map((id) => [id, new Set<string>()]));
  for (const id of summary.projectIds) for (const prereq of projectDependencies(summary, id)) {
    prerequisites.get(id)!.add(prereq);
    consumers.get(prereq)!.add(id);
  }
  const remaining = new Set(summary.projectIds);
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => prerequisites.get(id)!.size === 0).sort();
    if (ready.length === 0) throw new ProjectGraphError('cyclic cross-repository dependencies; resolve before scheduling');
    waves.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      for (const dependent of consumers.get(id)!) prerequisites.get(dependent)!.delete(id);
    }
  }
  return waves;
}
