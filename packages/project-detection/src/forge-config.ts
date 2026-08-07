/**
 * Small, repository-owned preview contract.
 *
 * This is intentionally limited to launch location, command, and port. It
 * must not become a second secrets or deployment configuration channel.
 */
export const FORGE_CONFIG_FILENAMES = ['forge.json', 'forge.config.json'] as const;

export interface ForgePreviewConfig {
  cwd: string;
  command?: string;
  port?: number;
}

export interface ForgeConfigResult {
  preview: ForgePreviewConfig | null;
  error?: string;
}

const MAX_COMMAND_LENGTH = 2_000;
const MAX_CWD_LENGTH = 500;

/** Normalize a repository-relative path without allowing checkout escape. */
export function normalizePreviewCwd(value: string): string | null {
  const raw = value.trim().replaceAll('\\', '/');
  if (!raw || raw === '.') return '.';
  if (raw.length > MAX_CWD_LENGTH || raw.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(raw)) return null;

  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join('/') : '.';
}

function invalid(message: string): ForgeConfigResult {
  return { preview: null, error: message };
}

/** Parse the JSON value loaded from forge.json or forge.config.json. */
export function parseForgeConfig(value: unknown): ForgeConfigResult {
  if (value === undefined || value === null) return { preview: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return invalid('Forge config must be a JSON object.');
  }

  const preview = (value as Record<string, unknown>).preview;
  if (preview === undefined || preview === null) return { preview: null };
  if (typeof preview !== 'object' || Array.isArray(preview)) {
    return invalid('Forge config preview must be an object.');
  }

  const raw = preview as Record<string, unknown>;
  const cwdValue = raw.cwd ?? '.';
  if (typeof cwdValue !== 'string') return invalid('Forge config preview.cwd must be a repository-relative string.');
  const cwd = normalizePreviewCwd(cwdValue);
  if (!cwd) return invalid('Forge config preview.cwd must stay inside the repository.');

  let command: string | undefined;
  if (raw.command !== undefined) {
    if (typeof raw.command !== 'string' || !raw.command.trim()) {
      return invalid('Forge config preview.command must be a non-empty string.');
    }
    command = raw.command.trim();
    if (command.length > MAX_COMMAND_LENGTH || /[\u0000-\u001f\u007f]/u.test(command)) {
      return invalid('Forge config preview.command is too long or contains control characters.');
    }
  }

  let port: number | undefined;
  if (raw.port !== undefined) {
    if (!Number.isInteger(raw.port) || (raw.port as number) < 1024 || (raw.port as number) > 65535) {
      return invalid('Forge config preview.port must be an integer from 1024 to 65535.');
    }
    port = raw.port as number;
  }

  return { preview: { cwd, ...(command ? { command } : {}), ...(port ? { port } : {}) } };
}
