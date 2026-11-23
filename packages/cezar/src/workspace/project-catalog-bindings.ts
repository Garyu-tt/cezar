/**
 * Resolve a remote GitHub catalog against already REGISTERED execution checkouts.
 *
 * Never guess from a folder name, project ID or untrusted GitHub display title.
 * A match requires the server-validated GitHub origin URL on ProjectListEntry,
 * built by forgeWebRoot from the parsed Git remote with credentials stripped.
 *
 * Read-only and best-effort: unmatched remote entries remain eligible for
 * ecosystem planning but MUST NOT be used as execution targets.
 */
import type { ProjectListEntry } from './projects.ts';

export interface CatalogBinding {
  fullName: string;
  projectId: string;
}

export interface AmbiguousCatalogBinding {
  fullName: string;
  projectIds: string[];
}

export interface CatalogResolution {
  bindings: CatalogBinding[];
  unregistered: string[];
  ambiguous: AmbiguousCatalogBinding[];
}

const repoPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function resolveGitHubCatalog(
  requested: readonly string[],
  registered: readonly Pick<ProjectListEntry, 'id' | 'repoUrl' | 'status'>[],
): CatalogResolution {
  if (requested.length > 1000) throw new Error('too many catalog repositories');
  const byOrigin = new Map<string, Set<string>>();
  for (const project of registered) {
    if (project.status !== 'ok' || !project.repoUrl) continue;
    let url: URL;
    try { url = new URL(project.repoUrl); } catch { continue; }
    // Only the official GitHub hostname for owner/repo catalog IDs. GitHub
    // Enterprise hosts are separate authorities and require explicit host IDs.
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') continue;
    if (url.search || url.hash || url.username || url.password || url.port) continue;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 2) continue;
    const fullName = segments.join('/');
    if (!repoPattern.test(fullName)) continue;
    const key = fullName.toLowerCase();
    const list = byOrigin.get(key) ?? new Set<string>();
    list.add(project.id);
    byOrigin.set(key, list);
  }

  const seen = new Set<string>();
  const result: CatalogResolution = { bindings: [], unregistered: [], ambiguous: [] };
  for (const fullName of requested) {
    if (typeof fullName !== 'string' || !repoPattern.test(fullName)) throw new Error('invalid GitHub catalog repository: ' + fullName);
    const key = fullName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const candidates = [...(byOrigin.get(key) ?? [])].sort();
    if (candidates.length === 0) result.unregistered.push(fullName);
    else if (candidates.length === 1) result.bindings.push({ fullName, projectId: candidates[0]! });
    else result.ambiguous.push({ fullName, projectIds: candidates });
  }
  return result;
}
