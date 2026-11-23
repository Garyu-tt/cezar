import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './config.ts';
import { registerProject, removeProject } from './projects.ts';
import {
  focusRegisteredProject, linkRegisteredProjects, unlinkRegisteredProjects,
  projectDependencies, projectExecutionWaves, projectFocusScope, projectGraphSummary,
  projectImpact, readProjectGraph,
} from './project-graph.ts';
import { runProjectsCommand } from './projects-cli.ts';

describe('native workspace project graph', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;
  let repos: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-graph-home-'));
    repos = mkdtempSync(join(realpathSync(tmpdir()), 'cez-graph-repos-'));
    process.env.CEZ_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repos, { recursive: true, force: true });
  });

  const add = async (name: string) => {
    const root = join(repos, name);
    mkdirSync(root, { recursive: true });
    return registerProject(root);
  };

  const seed = async () => {
    await add('adamantium-node');
    await add('AdamantiumToolBox');
    await add('mojum');
    await add('GenesisPE');
    return {
      node: 'adamantium-node',
      toolbox: 'adamantiumtoolbox',
      mojum: 'mojum',
      genesis: 'genesispe',
    };
  };

  it('does not write optional graph state until configured', async () => {
    await add('a');
    const config = await loadWorkspaceConfig();
    expect(config.projectGraph).toBeUndefined();
    expect(projectGraphSummary(config)).toMatchObject({
      focusProjectId: 'a', explicitFocusProjectId: null, links: [],
    });
  });

  it('keeps active Mojum focus separate from its parent and restart-safe', async () => {
    const ids = await seed();
    await linkRegisteredProjects(ids.mojum, ids.toolbox, 'part-of');
    await linkRegisteredProjects(ids.toolbox, ids.node, 'built-on');
    await focusRegisteredProject(ids.mojum);
    const saved = await loadWorkspaceConfig();
    expect(saved.projectGraph?.focusProjectId).toBe(ids.mojum);
    expect(saved.projectGraph?.links).toHaveLength(2);
    const graph = await readProjectGraph();
    expect(graph.focusProjectId).toBe(ids.mojum);
    expect(projectDependencies(graph, ids.mojum)).toEqual([ids.toolbox, ids.node]);
    expect(projectFocusScope(graph)).toEqual([ids.mojum, ids.toolbox, ids.node]);
    expect(projectImpact(graph, ids.node)).toEqual([ids.toolbox, ids.mojum]);
    expect(projectExecutionWaves(graph)).toEqual([
      [ids.node, ids.genesis].sort(), [ids.toolbox], [ids.mojum],
    ]);
  });

  it('supports a shared provider without duplicate registrations', async () => {
    const ids = await seed();
    await linkRegisteredProjects(ids.genesis, ids.mojum, 'provides-feature');
    await linkRegisteredProjects(ids.genesis, ids.toolbox, 'provides-feature');
    const graph = await readProjectGraph();
    expect(graph.projectIds).toHaveLength(4);
    expect(projectImpact(graph, ids.genesis)).toEqual([ids.mojum, ids.toolbox]);
    expect(projectDependencies(graph, ids.mojum)).toEqual([ids.genesis]);
    await unlinkRegisteredProjects(ids.genesis, ids.mojum, 'provides-feature');
    expect((await readProjectGraph()).links).toHaveLength(1);
  });

  it('rejects unknown ids, duplicates, self-links, multiple parents and containment cycles', async () => {
    const ids = await seed();
    await expect(linkRegisteredProjects(ids.mojum, 'not-registered', 'depends-on')).rejects.toThrow(/unknown/);
    await expect(focusRegisteredProject('not-registered')).rejects.toThrow(/unknown/);
    await expect(linkRegisteredProjects(ids.node, ids.node, 'depends-on')).rejects.toThrow(/cannot link to itself/);
    await linkRegisteredProjects(ids.mojum, ids.toolbox, 'part-of');
    await linkRegisteredProjects(ids.toolbox, ids.node, 'part-of');
    await expect(linkRegisteredProjects(ids.mojum, ids.toolbox, 'part-of')).rejects.toThrow(/already exists/);
    await expect(linkRegisteredProjects(ids.mojum, ids.genesis, 'part-of')).rejects.toThrow(/already has/);
    await expect(linkRegisteredProjects(ids.node, ids.mojum, 'part-of')).rejects.toThrow(/containment cycle/);
    expect((await readProjectGraph()).links).toHaveLength(2);
  });

  it('keeps arbitrary dependency cycles visible but blocks topological dispatch plans', async () => {
    const ids = await seed();
    await linkRegisteredProjects(ids.mojum, ids.toolbox, 'depends-on');
    await linkRegisteredProjects(ids.toolbox, ids.mojum, 'depends-on');
    const graph = await readProjectGraph();
    expect(graph.links).toHaveLength(2);
    expect(() => projectExecutionWaves(graph)).toThrow(/cyclic/);
  });

  it('removes incident graph links and stale focus atomically on unregister, without touching repo files', async () => {
    const ids = await seed();
    await linkRegisteredProjects(ids.mojum, ids.toolbox, 'part-of');
    await linkRegisteredProjects(ids.toolbox, ids.node, 'depends-on');
    await focusRegisteredProject(ids.toolbox);
    const marker = join(repos, 'AdamantiumToolBox', 'keep.txt');
    writeFileSync(marker, 'kept', 'utf8');
    expect(await removeProject(ids.toolbox)).toBe(true);
    const config = await loadWorkspaceConfig();
    expect(config.projectGraph?.links).toEqual([]);
    expect(config.projectGraph?.focusProjectId).toBeUndefined();
    expect(existsSync(marker)).toBe(true);
    expect((await readProjectGraph()).focusProjectId).toBe(ids.node);
  });

  it('surfaces unresolved links after a manual registry edit instead of silently losing them', async () => {
    const ids = await seed();
    await linkRegisteredProjects(ids.mojum, ids.node, 'depends-on');
    await mergeWriteWorkspaceConfig((config) => {
      config.projects = config.projects.filter((p) => p.id !== ids.node);
    });
    const graph = await readProjectGraph();
    expect(graph.links).toEqual([]);
    expect(graph.unresolvedLinks).toHaveLength(1);
    expect((await loadWorkspaceConfig()).projectGraph?.links).toHaveLength(1);
  });

  it('salvages malformed relations per entry and preserves future metadata', async () => {
    await seed();
    await mergeWriteWorkspaceConfig((config) => {
      config.projectGraph = {
        links: [
          { from: 'mojum', to: 'adamantium-node', type: 'built-on' },
          { from: 'mojum', to: '??!', type: 'depends-on' },
        ],
        futureMetadata: { keep: true },
      } as typeof config.projectGraph;
    });
    const config = await loadWorkspaceConfig();
    expect(config.projectGraph?.links).toHaveLength(1);
    expect(config.projectGraph?.futureMetadata).toEqual({ keep: true });
  });

  it('allows concurrent link additions through serialized merge-writes', async () => {
    const ids = await seed();
    await Promise.all([
      linkRegisteredProjects(ids.mojum, ids.node, 'built-on'),
      linkRegisteredProjects(ids.toolbox, ids.node, 'built-on'),
    ]);
    expect((await readProjectGraph()).links).toHaveLength(2);
  });

  it('exposes native CLI graph inspection and blocks mutations under single-project mode', async () => {
    const ids = await seed();
    const out: string[] = [], err: string[] = [];
    const io = { log: (value: string) => out.push(value), error: (value: string) => err.push(value) };
    const run = (...args: string[]) => runProjectsCommand(args, { defaultRoot: repos, env: {}, io });
    expect(await run('link', ids.mojum, ids.node, 'depends-on')).toBe(0);
    expect(await run('focus', ids.mojum)).toBe(0);
    expect(await run('graph')).toBe(0);
    expect(out.join(' ')).toContain('scope: mojum, adamantium-node');
    expect(await run('impact', ids.node)).toBe(0);
    expect(out.join(' ')).toContain('affects: mojum');
    expect(await run('waves')).toBe(0);
    const before = await loadWorkspaceConfig();
    const restricted = (...args: string[]) => runProjectsCommand(args, {
      defaultRoot: repos, env: { CEZ_SINGLE_PROJECT: '1' }, bootProjectId: ids.mojum, io,
    });
    expect(await restricted('link', ids.mojum, ids.toolbox, 'depends-on')).toBe(1);
    expect(await restricted('graph')).toBe(1);
    expect((await loadWorkspaceConfig()).projectGraph).toEqual(before.projectGraph);
    expect(err.join(' ')).toContain('single-project mode');
  });
});
