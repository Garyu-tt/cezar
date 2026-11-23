import { describe, expect, it } from 'vitest';
import { resolveGitHubCatalog } from './project-catalog-bindings.ts';

const project = (id: string, repoUrl: string | undefined, status: 'ok' | 'missing' | 'not-git' = 'ok') =>
  ({ id, repoUrl, status });

describe('GitHub catalog to registered checkout binding', () => {
  it('maps only exact authenticated Git remote identities, never project/folder-name guesses', () => {
    const mapped = resolveGitHubCatalog([
      'Garyu-tt/mojum', 'Garyu-tt/AdamantiumToolBox', 'Garyu-tt/GenesisPE',
    ], [
      project('mojum', 'https://github.com/Garyu-tt/mojum'),
      project('random-folder', 'https://github.com/Garyu-tt/AdamantiumToolBox'),
      project('genesispe', undefined),
    ]);
    expect(mapped).toEqual({
      bindings: [
        { fullName: 'Garyu-tt/mojum', projectId: 'mojum' },
        { fullName: 'Garyu-tt/AdamantiumToolBox', projectId: 'random-folder' },
      ],
      unregistered: ['Garyu-tt/GenesisPE'],
      ambiguous: [],
    });
  });

  it('does not guess a target when two local checkouts share one origin', () => {
    const mapped = resolveGitHubCatalog(['Garyu-tt/mojum'], [
      project('mojum-staging', 'https://github.com/Garyu-tt/mojum'),
      project('mojum-prod', 'https://github.com/garyu-tt/MoJuM'),
    ]);
    expect(mapped.bindings).toEqual([]);
    expect(mapped.ambiguous).toEqual([{ fullName: 'Garyu-tt/mojum', projectIds: ['mojum-prod', 'mojum-staging'] }]);
  });

  it('ignores missing clones, non-GitHub hosts, credentials, paths and fake authority', () => {
    const mapped = resolveGitHubCatalog(['Garyu-tt/mojum'], [
      project('gone', 'https://github.com/Garyu-tt/mojum', 'missing'),
      project('hostile', 'https://github.com.evil.test/Garyu-tt/mojum'),
      project('credential', 'https://token:pass@github.com/Garyu-tt/mojum'),
      project('extra', 'https://github.com/Garyu-tt/mojum/extra'),
      project('enterprise', 'https://ghe.com/Garyu-tt/mojum'),
      project('no-git', undefined, 'not-git'),
    ]);
    expect(mapped).toEqual({ bindings: [], unregistered: ['Garyu-tt/mojum'], ambiguous: [] });
  });

  it('handles GitHub names case-insensitively, deduplicates and keeps remote-only entries', () => {
    const mapped = resolveGitHubCatalog(
      ['Garyu-tt/mojum', 'garyu-tt/MOJUM', 'Garyu-tt/mujoco'],
      [project('current', 'https://github.com/garyu-tt/MoJuM')],
    );
    expect(mapped.bindings).toEqual([{ fullName: 'Garyu-tt/mojum', projectId: 'current' }]);
    expect(mapped.unregistered).toEqual(['Garyu-tt/mujoco']);
  });

  it('refuses invalid inputs and oversized catalog lists', () => {
    expect(() => resolveGitHubCatalog(['../../secret'], [])).toThrow(/invalid GitHub catalog repository/);
    expect(() => resolveGitHubCatalog(Array.from({ length: 1001 }, (_, i) => `owner/repo${i}`), []))
      .toThrow(/too many/);
  });
});
