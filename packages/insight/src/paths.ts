/** Deterministic, syntax-only path classification shared across insight tools. */

export interface PathFacts {
  path: string;
  isTest: boolean;
  isConfig: boolean;
  isMigration: boolean;
  isGenerated: boolean;
  isLockfile: boolean;
  isDoc: boolean;
  isWorkerConfig: boolean;
  isBuildTooling: boolean;
  /** Monorepo unit, e.g. `packages/core` or `apps/web`, when the path is inside one. */
  packageDir: string | null;
}

const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'uv.lock',
  'Cargo.lock',
  'go.sum',
  'poetry.lock'
]);

const WORKER_CONFIG = /(^|\/)wrangler\.(jsonc|toml|json)$/;
const BUILD_TOOLING = /(^|\/)(vite|rollup|webpack|esbuild|tsup|turbo|nx)\.config\.[cm]?[jt]s$|(^|\/)Dockerfile$|(^|\/)tsconfig(\.\w+)?\.json$/;
const CONFIG = /\.(json|jsonc|toml|ya?ml|ini|env|config\.[cm]?[jt]s)$|(^|\/)\.[^/]+rc(\.\w+)?$/;
const TEST = /(\.|_|-)(test|spec)\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__|e2e)\//;
const MIGRATION = /(^|\/)migrations?\/|(^|\/)migrate\//i;
const GENERATED = /(^|\/)(dist|build|out|\.next|\.turbo|coverage|node_modules|worker-configuration\.d\.ts|.*\.gen\.[cm]?[jt]s)(\/|$)/;
const DOC = /\.(md|mdx|txt|rst)$|(^|\/)docs?\//i;

export function classifyPath(path: string): PathFacts {
  const base = path.split('/').at(-1) ?? path;
  const packageMatch = /^((?:packages|apps|workflows|examples)\/[^/]+)\//.exec(path);
  const isLockfile = LOCKFILES.has(base);
  const isWorkerConfig = WORKER_CONFIG.test(path);
  const isBuildTooling = BUILD_TOOLING.test(path);
  return {
    path,
    isTest: TEST.test(path),
    isConfig: !isBuildTooling && !isWorkerConfig && CONFIG.test(path),
    isMigration: MIGRATION.test(path),
    isGenerated: GENERATED.test(path),
    isLockfile,
    isDoc: DOC.test(path),
    isWorkerConfig,
    isBuildTooling,
    packageDir: packageMatch?.[1] ?? null
  };
}

/** Stable, dependency-free FNV-1a hash so analysis stays synchronous and testable. */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
