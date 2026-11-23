import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerProject } from '../workspace/projects.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { createProjectGraphRoutes } from './project-graph-api.ts';

describe('workspace project graph API', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;
  let root: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-project-graph-api-'));
    root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-project-graph-api-repos-'));
    process.env.CEZ_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const register = async (name: string) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return registerProject(path);
  };
  const api = () => createProjectGraphRoutes(() => false);
  const request = (app: ReturnType<typeof api>, method: string, path: string, body: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('reads an empty native graph and never exposes repository paths', async () => {
    await register('one');
    await register('two');
    const res = await api().request('/workspace/project-graph');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ projectIds: ['one', 'two'], focusProjectId: 'one', links: [] });
    expect(JSON.stringify(json)).not.toContain(root);
  });

  it('persists focus and validated link updates through standard workspace routes', async () => {
    await register('mojum');
    await register('adamantium-node');
    const app = api();
    const link = { from: 'mojum', to: 'adamantium-node', type: 'built-on' };
    const linked = await request(app, 'POST', '/workspace/project-graph/links', link);
    expect(linked.status).toBe(200);
    expect((await linked.json() as { links: unknown[] }).links).toHaveLength(1);
    const focused = await request(app, 'PUT', '/workspace/project-graph/focus', { projectId: 'mojum' });
    expect(focused.status).toBe(200);
    expect((await focused.json() as { focusProjectId: string }).focusProjectId).toBe('mojum');
    expect((await loadWorkspaceConfig()).projectGraph?.links).toEqual([link]);
    const removed = await request(app, 'DELETE', '/workspace/project-graph/links', link);
    expect(removed.status).toBe(200);
    expect((await removed.json() as { links: unknown[] }).links).toHaveLength(0);
  });

  it('rejects cycles, bad JSON, unregistered targets and duplicate links without state damage', async () => {
    await register('one');
    await register('two');
    const app = api();
    const one = { from: 'one', to: 'two', type: 'part-of' };
    expect((await request(app, 'POST', '/workspace/project-graph/links', one)).status).toBe(200);
    expect((await request(app, 'POST', '/workspace/project-graph/links', one)).status).toBe(400);
    expect((await request(app, 'POST', '/workspace/project-graph/links',
      { from: 'two', to: 'one', type: 'part-of' })).status).toBe(400);
    expect((await request(app, 'POST', '/workspace/project-graph/links',
      { from: 'one', to: 'three', type: 'depends-on' })).status).toBe(400);
    expect((await request(app, 'POST', '/workspace/project-graph/links',
      { from: 'one', to: 'two', type: 'unsupported' })).status).toBe(400);
    expect((await request(app, 'PUT', '/workspace/project-graph/focus',
      { projectId: 'missing' })).status).toBe(400);
    expect((await app.request('/workspace/project-graph/links', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{broken' })).status).toBe(400);
    expect((await loadWorkspaceConfig()).projectGraph?.links).toEqual([one]);
  });


  it('resolves a remote catalog read-only, leaving unregistered GitHub repos unavailable', async () => {
    await register('mojum');
    const app = api();
    const good = await request(app, 'POST', '/workspace/project-graph/catalog-bindings', {
      repositories: ['Garyu-tt/mojum', 'Garyu-tt/GenesisPE'],
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({
      bindings: [],
      unregistered: ['Garyu-tt/mojum', 'Garyu-tt/GenesisPE'],
      ambiguous: [],
    });
    expect((await loadWorkspaceConfig()).projectGraph).toBeUndefined();
    expect((await request(app, 'POST', '/workspace/project-graph/catalog-bindings',
      { repositories: ['../../bad'] })).status).toBe(400);
  });

  it('refuses all inspection and mutations without writing in single-project mode', async () => {
    await register('one');
    await register('two');
    const restricted = createProjectGraphRoutes(() => true);
    expect((await restricted.request('/workspace/project-graph')).status).toBe(409);
    expect((await request(restricted, 'POST', '/workspace/project-graph/catalog-bindings',
      { repositories: ['Garyu-tt/mojum'] })).status).toBe(409);
    expect((await request(restricted, 'POST', '/workspace/project-graph/links',
      { from: 'one', to: 'two', type: 'depends-on' })).status).toBe(409);
    expect((await request(restricted, 'PUT', '/workspace/project-graph/focus',
      { projectId: 'two' })).status).toBe(409);
    expect((await request(restricted, 'DELETE', '/workspace/project-graph/links',
      { from: 'one', to: 'two', type: 'depends-on' })).status).toBe(409);
    expect((await loadWorkspaceConfig()).projectGraph).toBeUndefined();
  });
});
