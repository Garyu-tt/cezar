import { describe, expect, it } from 'vitest';
import type { ProjectGraphSummary } from './project-graph.ts';
import { previewNativeProjectPlan } from './project-graph-planner.ts';
import { previewProjectRouting } from './project-graph-routing.ts';
import type { ProjectListEntry } from './projects.ts';

const project = (id: string, status: ProjectListEntry['status'] = 'ok') => ({ id, status });
const ids = ['mojum', 'adamantiumtoolbox', 'adamantium-node', 'independent'];
const baseGraph = (): ProjectGraphSummary => ({
  projectIds: [...ids],
  focusProjectId: 'mojum',
  explicitFocusProjectId: 'mojum',
  links: [
    { from: 'mojum', to: 'adamantiumtoolbox', type: 'part-of' },
    { from: 'adamantiumtoolbox', to: 'adamantium-node', type: 'built-on' },
  ],
  unresolvedLinks: [],
});
function preview(
  graph: ProjectGraphSummary,
  statuses: Array<{ id: string; status: ProjectListEntry['status'] }> = ids.map((id) => project(id)),
  logicalProjectId = 'mojum',
  executionProjectId = 'adamantium-node',
) {
  return previewProjectRouting(
    graph,
    previewNativeProjectPlan(graph, statuses),
    logicalProjectId,
    executionProjectId,
  );
}

describe('native project routing preflight', () => {
  it('maps a logical Mojum task onto an explicit registered platform worktree, without launch', () => {
    const selection = preview(baseGraph());
    expect(selection).toEqual({
      logicalProjectId: 'mojum',
      executionProjectId: 'adamantium-node',
      eligible: true,
      reason: 'ready',
      nativePoolEndpoint: '/api/v1/p/adamantium-node/agent-pool/jobs',
      blockedReason: null,
      blockedBy: [],
      logicalScope: ['mojum', 'adamantiumtoolbox', 'adamantium-node'],
      previewOnly: true,
    });
  });

  it('does not redirect a Mojum task into unrelated healthy project', () => {
    const selection = preview(baseGraph(), ids.map((id) => project(id)), 'mojum', 'independent');
    expect(selection).toMatchObject({
      eligible: false, reason: 'outside-logical-scope',
      nativePoolEndpoint: null,
    });
  });

  it('still allows an unrelated project to own its own independently planned work', () => {
    const selection = preview(baseGraph(), ids.map((id) => project(id)), 'independent', 'independent');
    expect(selection).toMatchObject({
      eligible: true, reason: 'ready', logicalScope: ['independent'],
      nativePoolEndpoint: '/api/v1/p/independent/agent-pool/jobs',
    });
  });

  it('refuses missing/unsafe project IDs, never constructs an injection endpoint', () => {
    const g = baseGraph();
    expect(preview(g, ids.map((id) => project(id)), '../../etc/passwd', 'mojum')).toMatchObject({
      eligible: false, reason: 'unknown-logical-project', nativePoolEndpoint: null,
    });
    expect(preview(g, ids.map((id) => project(id)), 'mojum', 'unknown-repo')).toMatchObject({
      eligible: false, reason: 'unknown-execution-project', nativePoolEndpoint: null,
    });
  });

  it('blocks a missing execution checkout even when it is a legitimate dependency', () => {
    const statuses = ids.map((id) => project(id, id === 'adamantium-node' ? 'missing' : 'ok'));
    const selection = preview(baseGraph(), statuses);
    expect(selection).toMatchObject({
      eligible: false,
      reason: 'execution-blocked',
      blockedReason: 'missing-checkout',
      nativePoolEndpoint: null,
    });
  });

  it('keeps a ready platform project selectable even if its owning product is blocked', () => {
    const statuses = ids.map((id) => project(id, id === 'mojum' ? 'missing' : 'ok'));
    const selection = preview(baseGraph(), statuses);
    expect(selection).toMatchObject({
      eligible: true, reason: 'ready',
      nativePoolEndpoint: '/api/v1/p/adamantium-node/agent-pool/jobs',
    });
  });

  it('refuses cyclic execution components but allows a healthy independent project', () => {
    const g = baseGraph();
    g.links = [
      { from: 'mojum', to: 'adamantiumtoolbox', type: 'depends-on' },
      { from: 'adamantiumtoolbox', to: 'mojum', type: 'depends-on' },
    ];
    expect(preview(g, ids.map((id) => project(id)), 'mojum', 'mojum')).toMatchObject({
      eligible: false, blockedReason: 'cycle-or-dependent',
    });
    expect(preview(g, ids.map((id) => project(id)), 'independent', 'independent')).toMatchObject({
      eligible: true, reason: 'ready',
    });
  });

  it('never accepts a stale/incomplete plan as proof of readiness', () => {
    const g = baseGraph();
    const plan = previewNativeProjectPlan(g, ids.map((id) => project(id)));
    plan.waves = [];
    const selection = previewProjectRouting(g, plan, 'mojum', 'adamantium-node');
    expect(selection).toMatchObject({
      eligible: false, reason: 'execution-blocked', nativePoolEndpoint: null,
    });
  });

  it('supports a provider that supplies a feature to the product', () => {
    const g = baseGraph();
    g.links = [{ from: 'adamantium-node', to: 'mojum', type: 'provides-feature' }];
    expect(preview(g)).toMatchObject({
      eligible: true, reason: 'ready', logicalScope: ['mojum', 'adamantium-node'],
    });
  });

  it('keeps a blocked downstream product from claiming execution in a healthy sibling', () => {
    const g = baseGraph();
    g.links.push({ from: 'independent', to: 'adamantium-node', type: 'depends-on' });
    const target = preview(g, ids.map((id) => project(id)), 'mojum', 'independent');
    expect(target).toMatchObject({
      eligible: false, reason: 'outside-logical-scope',
    });
  });
});
