/**
 * Same-origin workspace API for the native graph of registered Cezar repositories.
 * These routes never accept a filesystem path or a remote repository URL.
 * CEZ_SINGLE_PROJECT refuses reads as well as writes: other registered project
 * identities must not leak into constrained cockpit sessions.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  ProjectGraphError,
  PROJECT_RELATION_TYPES,
  focusRegisteredProject,
  linkRegisteredProjects,
  readProjectGraph,
  unlinkRegisteredProjects,
} from '../workspace/project-graph.ts';
import { PROJECT_ID_RE } from '../workspace/config.ts';
import { listProjects } from '../workspace/projects.ts';
import { resolveGitHubCatalog } from '../workspace/project-catalog-bindings.ts';

const id = z.string().regex(PROJECT_ID_RE);
const focusInput = z.object({ projectId: id.nullable() });
const linkInput = z.object({
  from: id,
  to: id,
  type: z.enum(PROJECT_RELATION_TYPES),
});

const catalogInput = z.object({
  repositories: z.array(z.string().regex(/^[a-zA-Z0-9_.-]+\\/[a-zA-Z0-9_.-]+$/)).max(1000),
});

export function createProjectGraphRoutes(singleProject: () => boolean) {
  const refuses = () => ({ error: 'single-project mode is enabled; the workspace graph is unavailable' });
  const failure = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // Domain errors are bad graph input, never a reason to mutate another repo.
    return { error: message };
  };

  return new Hono()
    // Pure verification: the caller supplies catalog IDs, the server matches ONLY
    // parsed origin remotes already registered in Cezar. No clone, GitHub API or write.
    .post('/workspace/project-graph/catalog-bindings', async (c) => {
      if (singleProject()) return c.json(refuses(), 409);
      const input = catalogInput.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ error: 'invalid GitHub catalog' }, 400);
      try {
        return c.json(resolveGitHubCatalog(input.data.repositories, await listProjects()), 200);
      } catch (error) {
        return c.json(failure(error), 500);
      }
    })
    .get('/workspace/project-graph', async (c) => {
      if (singleProject()) return c.json(refuses(), 409);
      try {
        return c.json(await readProjectGraph(), 200);
      } catch (error) {
        return c.json(failure(error), 500);
      }
    })
    .put('/workspace/project-graph/focus', async (c) => {
      if (singleProject()) return c.json(refuses(), 409);
      const body = focusInput.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: 'invalid projectId' }, 400);
      try {
        await focusRegisteredProject(body.data.projectId);
        return c.json(await readProjectGraph(), 200);
      } catch (error) {
        return c.json(failure(error), error instanceof ProjectGraphError ? 400 : 500);
      }
    })
    .post('/workspace/project-graph/links', async (c) => {
      if (singleProject()) return c.json(refuses(), 409);
      const body = linkInput.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: 'invalid relationship' }, 400);
      try {
        await linkRegisteredProjects(body.data.from, body.data.to, body.data.type);
        return c.json(await readProjectGraph(), 200);
      } catch (error) {
        return c.json(failure(error), error instanceof ProjectGraphError ? 400 : 500);
      }
    })
    .delete('/workspace/project-graph/links', async (c) => {
      if (singleProject()) return c.json(refuses(), 409);
      const body = linkInput.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: 'invalid relationship' }, 400);
      try {
        await unlinkRegisteredProjects(body.data.from, body.data.to, body.data.type);
        return c.json(await readProjectGraph(), 200);
      } catch (error) {
        return c.json(failure(error), error instanceof ProjectGraphError ? 400 : 500);
      }
    });
}
