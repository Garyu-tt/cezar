import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * A local OpenCode provider configured with a static loopback API endpoint
 * need not have an OAuth login. Only the native agent pool, with a model
 * explicitly selected by the operator, may use this narrow preflight.
 *
 * This does NOT alter global provider authentication, bypass a disabled
 * provider, or treat a missing/unknown endpoint as available.
 */
export async function localOpenCodeModelReady(
  model: string,
  options: {
    configRoot?: string;
    health?: (port: number) => Promise<boolean>;
  } = {},
): Promise<boolean> {
  const parsed = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})$/.exec(model);
  if (!parsed) return false;
  const configRoot = options.configRoot
    ?? process.env.XDG_CONFIG_HOME
    ?? join(homedir(), '.config');
  try {
    const filename = join(configRoot, 'opencode', 'opencode.json');
    const text = await readFile(filename, 'utf8');
    if (text.length > 512_000) return false;
    const config: unknown = JSON.parse(text);
    if (!config || typeof config !== 'object') return false;
    const { provider, enabled_providers } = config as {
      provider?: Record<string, unknown>;
      enabled_providers?: unknown;
    };
    const id = parsed[1]!;
    const name = parsed[2]!;
    if (!Array.isArray(enabled_providers) || !enabled_providers.includes(id)) return false;
    const selected = provider?.[id];
    if (!selected || typeof selected !== 'object') return false;
    const entry = selected as {
      npm?: unknown; options?: { baseURL?: unknown }; models?: Record<string, unknown>;
    };
    if (entry.npm !== '@ai-sdk/openai-compatible' || !entry.models?.[name]) return false;
    const address = entry.options?.baseURL;
    if (typeof address !== 'string') return false;
    // No hostname, localhost alias, query string, nonloopback IP, or redirects.
    const local = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{1,4})\/v1\/?$/.exec(address);
    if (!local) return false;
    const port = Number(local[1]);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) return false;
    const health = options.health ?? (async (port: number): Promise<boolean> => {
      const response = await fetch('http://127.0.0.1:' + port + '/health', {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok || response.url !== 'http://127.0.0.1:' + port + '/health') return false;
      const data: unknown = await response.json();
      return typeof data === 'object' && data !== null
        && (data as { status?: unknown }).status === 'ok';
    });
    return await health(port);
  } catch {
    return false;
  }
}
