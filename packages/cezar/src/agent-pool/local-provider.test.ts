import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { localOpenCodeModelReady } from './local-provider.ts';

const homes: string[] = [];
const defaultProvider = (baseURL: string) => ({
  npm: '@ai-sdk/openai-compatible',
  options: { baseURL, apiKey: 'local-unit-test-only' },
  models: { coder3b: { name: 'fixture' } },
});
async function fixture(baseURL: string, enabled = true, npm = '@ai-sdk/openai-compatible') {
  const home = await mkdtemp(join(tmpdir(), 'cezar-local-provider-'));
  homes.push(home);
  await mkdir(join(home, 'opencode'));
  await writeFile(join(home, 'opencode', 'opencode.json'), JSON.stringify({
    provider: { 'local-coder': { ...defaultProvider(baseURL), npm } },
    enabled_providers: enabled ? ['local-coder'] : [],
  }));
  return home;
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map(h => rm(h, { recursive: true, force: true })));
});
describe('native Cezar local provider preflight', () => {
  it('accepts only an explicitly enabled local model with successful health', async () => {
    const configRoot = await fixture('http://127.0.0.1:48083/v1');
    const seen: number[] = [];
    const ok = await localOpenCodeModelReady('local-coder/coder3b', {
      configRoot,
      health: async (port) => { seen.push(port); return true; },
    });
    expect(ok).toBe(true);
    expect(seen).toEqual([48083]);
  });
  it('refuses disabled providers, invalid models, and incompatible provider implementations', async () => {
    const disabled = await fixture('http://127.0.0.1:48083/v1', false);
    const other = await fixture('http://127.0.0.1:48083/v1', true, '@ai-sdk/openai');
    const health = async () => { throw Error('should not call provider'); };
    expect(await localOpenCodeModelReady('local-coder/coder3b', { configRoot: disabled, health })).toBe(false);
    expect(await localOpenCodeModelReady('local-coder/coder3b', { configRoot: other, health })).toBe(false);
    expect(await localOpenCodeModelReady('local-coder/unknown', { configRoot: disabled, health })).toBe(false);
    expect(await localOpenCodeModelReady('../local-coder/coder3b', { configRoot: disabled, health })).toBe(false);
  });
  it('never calls nonloopback endpoints or untrusted localhost variants', async () => {
    for (const url of [
      'http://example.org:48083/v1',
      'http://localhost:48083/v1',
      'http://127.0.0.1.evil.com:48083/v1',
      'https://127.0.0.1:48083/v1',
      'http://[::1]:48083/v1',
      'http://127.0.0.1:80/v1',
      'http://127.0.0.1:99999/v1',
      'http://127.0.0.1:48083/v1?x=1',
    ]) {
      const configRoot = await fixture(url);
      let called = false;
      expect(await localOpenCodeModelReady('local-coder/coder3b', {
        configRoot,
        health: async () => { called = true; return true; },
      }), url).toBe(false);
      expect(called, url).toBe(false);
    }
  });
  it('refuses unreachable local model without caching a false connected state', async () => {
    const configRoot = await fixture('http://127.0.0.1:48083/v1');
    expect(await localOpenCodeModelReady('local-coder/coder3b', {
      configRoot, health: async () => false,
    })).toBe(false);
    expect(await localOpenCodeModelReady('local-coder/coder3b', {
      configRoot, health: async () => true,
    })).toBe(true);
  });
});
