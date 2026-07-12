import type { SandboxHandle } from '@forge/sandbox-core';

export interface RepositoryIndex {
  schemaVersion: 1;
  repositoryCommit: string;
  indexerVersion: string;
  files: string[];
  languages: Record<string, number>;
  manifests: string[];
  instructions: string[];
}

const languageByExtension: Record<string, string> = {
  '.astro': 'Astro',
  '.css': 'CSS',
  '.go': 'Go',
  '.html': 'HTML',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.json': 'JSON',
  '.md': 'Markdown',
  '.mjs': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.sql': 'SQL',
  '.svelte': 'Svelte',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.vue': 'Vue'
};

export async function buildDeterministicRepositoryIndex(
  handle: SandboxHandle,
  cwd = '/workspace/repo'
): Promise<RepositoryIndex> {
  const result = await handle.exec({
    command: "git rev-parse HEAD && printf '\\n--FILES--\\n' && git ls-files -z",
    cwd,
    timeoutMs: 60_000,
    outputLimitBytes: 5_000_000,
    sessionId: 'indexer',
    networkPolicy: 'deny_all'
  });
  if (result.exitCode !== 0) throw new Error('Repository index could not read Git metadata.');
  const [commitPart = '', filePart = ''] = result.stdout.split('\n--FILES--\n');
  const files = filePart.split('\0').filter(Boolean).sort();
  const languages: Record<string, number> = {};
  for (const file of files) {
    const dot = file.lastIndexOf('.');
    const language = dot >= 0 ? languageByExtension[file.slice(dot)] : undefined;
    if (language) languages[language] = (languages[language] ?? 0) + 1;
  }
  const manifestNames = new Set([
    'package.json',
    'pnpm-workspace.yaml',
    'pyproject.toml',
    'requirements.txt',
    'Cargo.toml',
    'go.mod',
    'wrangler.jsonc',
    'wrangler.toml'
  ]);
  const instructionNames = new Set(['AGENTS.md', 'CLAUDE.md', 'CODEX.md', '.github/copilot-instructions.md']);
  return {
    schemaVersion: 1,
    repositoryCommit: commitPart.trim(),
    indexerVersion: '0.1.0',
    files,
    languages,
    manifests: files.filter((file) => manifestNames.has(file.split('/').at(-1) ?? file)),
    instructions: files.filter((file) => instructionNames.has(file) || instructionNames.has(file.split('/').at(-1) ?? file))
  };
}
