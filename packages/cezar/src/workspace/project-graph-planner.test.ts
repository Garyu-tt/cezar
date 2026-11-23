import { describe, expect, it } from 'vitest';
import type { ProjectGraphSummary } from './project-graph.ts';
import type { ProjectListEntry } from './projects.ts';
import { previewNativeProjectPlan } from './project-graph-planner.ts';

const graph = (links: ProjectGraphSummary['links'] = []): ProjectGraphSummary => ({
  focusProjectId: 'mojum',
  explicitFocusProjectId: 'mojum',
  projectIds: ['adamantium-node', 'adamantiumtoolbox', 'mojum', 'independent'],
  links,
  unresolvedLinks: [],
});
const project = (
  id: string, status: ProjectListEntry['status'] = 'ok',
): Pick<ProjectListEntry, 'id' | 'status'> => ({ id, status });
const status = (...overrides: Array<[string, ProjectListEntry['status']]>) => {
  const map = new Map(overrides);
  return graph().projectIds.map((id) => project(id, map.get(id) ?? 'ok'));
};
const architecture: ProjectGraphSummary['links'] = [
  { from: 'mojum', to: 'adamantiumtoolbox', type: 'part-of' },
  { from: 'adamantiumtoolbox', to: 'adamantium-node', type: 'built-on' },
];

describe('safe multi-repository portfolio plan', () => {
  it('plans all repositories in dependency-first parallel batches, regardless of focus', () => {
    expect(previewNativeProjectPlan(graph(architecture), status())).toEqual({
      focusProjectId: 'mojum',
      focusScope: ['mojum', 'adamantiumtoolbox', 'adamantium-node'],
      waves: [['adamantium-node', 'independent'], ['adamantiumtoolbox'], ['mojum']],
      blocked: [],
      unresolvedLinks: [],
      previewOnly: true,
    });
  });

  it('keeps unrelated repos runnable if a shared foundation is missing', () => {
    const plan = previewNativeProjectPlan(graph(architecture), status(['adamantium-node', 'missing']));
    expect(plan.waves).toEqual([['independent']]);
    expect(plan.blocked).toEqual([
      { id: 'adamantium-node', reason: 'missing-checkout', blockedBy: [] },
      { id: 'adamantiumtoolbox', reason: 'blocked-dependency', blockedBy: ['adamantium-node'] },
      { id: 'mojum', reason: 'blocked-dependency', blockedBy: ['adamantiumtoolbox'] },
    ]);
  });

  it('does not run a consumer whose prerequisite was manually removed from registry', () => {
    const old = graph(architecture);
    old.unresolvedLinks = [{ from: 'mojum', to: 'deleted-provider', type: 'depends-on' }];
    const plan = previewNativeProjectPlan(old, status());
    expect(plan.blocked).toContainEqual({
      id: 'mojum', reason: 'unresolved-dependency', blockedBy: ['deleted-provider'],
    });
    expect(plan.waves).toEqual([['adamantium-node', 'independent'], ['adamantiumtoolbox']]);
  });

  it('isolates cyclic components while scheduling independent safe repositories', () => {
    const cycle = graph([
      { from: 'mojum', to: 'adamantiumtoolbox', type: 'depends-on' },
      { from: 'adamantiumtoolbox', to: 'mojum', type: 'depends-on' },
    ]);
    const plan = previewNativeProjectPlan(cycle, status());
    expect(plan.waves).toEqual([['adamantium-node', 'independent']]);
    expect(plan.blocked).toEqual([
      { id: 'adamantiumtoolbox', reason: 'cycle-or-dependent', blockedBy: ['mojum'] },
      { id: 'mojum', reason: 'cycle-or-dependent', blockedBy: ['adamantiumtoolbox'] },
    ]);
  });

  it('uses provider -> consumer ordering for provides-feature, unlike depends-on', () => {
    const g = graph([
      { from: 'adamantium-node', to: 'mojum', type: 'provides-feature' },
    ]);
    expect(previewNativeProjectPlan(g, status()).waves).toEqual([
      ['adamantium-node', 'adamantiumtoolbox', 'independent'], ['mojum'],
    ]);
  });

  it('reports not-git and propagates blocked dependencies rather than pretending PRs can run', () => {
    const g = graph([{ from: 'mojum', to: 'adamantium-node', type: 'depends-on' }]);
    const plan = previewNativeProjectPlan(g, status(['adamantium-node', 'not-git']));
    expect(plan.waves).toEqual([['adamantiumtoolbox', 'independent']]);
    expect(plan.blocked).toEqual([
      { id: 'adamantium-node', reason: 'not-git', blockedBy: [] },
      { id: 'mojum', reason: 'blocked-dependency', blockedBy: ['adamantium-node'] },
    ]);
  });

  it('fails closed for a graph ID missing from the status-probed workspace', () => {
    const g = graph();
    const seen = [project('mojum'), project('independent')];
    const plan = previewNativeProjectPlan(g, seen);
    expect(plan.waves).toEqual([['independent', 'mojum']]);
    expect(plan.blocked.map((b) => [b.id, b.reason])).toEqual([
      ['adamantium-node', 'missing-checkout'], ['adamantiumtoolbox', 'missing-checkout'],
    ]);
  });

  it('blocks a missing feature provider even though its link direction is reversed', () => {
    const old = graph();
    old.unresolvedLinks = [{ from: 'unregistered-provider', to: 'mojum', type: 'provides-feature' }];
    const plan = previewNativeProjectPlan(old, status());
    expect(plan.blocked).toContainEqual({
      id: 'mojum', reason: 'unresolved-dependency', blockedBy: ['unregistered-provider'],
    });
  });
});
