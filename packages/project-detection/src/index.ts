import type { SandboxHandle } from '@forge/sandbox-core';

export interface ProjectDetection {
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | 'pip' | 'uv' | 'unknown';
  framework: string | null;
  installCommand: string | null;
  devCommand: string | null;
  buildCommand: string | null;
  expectedPorts: number[];
}

const UNKNOWN_DETECTION: ProjectDetection = {
  packageManager: 'unknown',
  framework: null,
  installCommand: null,
  devCommand: null,
  buildCommand: null,
  expectedPorts: []
};

// The detection probe: a single node script (heredoc) that inspects the checkout
// and prints one JSON line of {pm, framework, scripts}. Exported so the provisioner
// can fold it into a larger combined exec and reuse `parseDetection` on the output.
export const DETECTION_SCRIPT = `node - <<'NODE'\nconst fs=require('fs');\nconst read=(p)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return null}};\nconst pkg=read('package.json');\nconst exists=(p)=>fs.existsSync(p);\nlet pm='unknown';\nif(exists('pnpm-lock.yaml'))pm='pnpm';else if(exists('bun.lock')||exists('bun.lockb'))pm='bun';else if(exists('yarn.lock'))pm='yarn';else if(exists('package-lock.json'))pm='npm';else if(exists('uv.lock'))pm='uv';else if(exists('requirements.txt')||exists('pyproject.toml'))pm='pip';\nlet framework=null; const all={...(pkg?.dependencies||{}),...(pkg?.devDependencies||{})};\nfor(const [name,label] of [['astro','astro'],['next','nextjs'],['vite','vite'],['@redwoodjs/core','redwoodjs'],['rwsdk','redwoodsdk'],['nuxt','nuxt'],['svelte','sveltekit']]) if(all[name]){framework=label;break}\nconsole.log(JSON.stringify({pm,framework,scripts:pkg?.scripts||{}}));\nNODE`;

// Pure parser for the detection probe's stdout. Returns the unknown default when
// the output is missing or unparseable (mirrors the exec exitCode!==0 fallback).
export function parseDetection(stdout: string): ProjectDetection {
  let parsed: { pm: ProjectDetection['packageManager']; framework: string | null; scripts: Record<string, string> };
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { ...UNKNOWN_DETECTION };
  }
  const install: Record<ProjectDetection['packageManager'], string | null> = {
    pnpm: 'pnpm install --frozen-lockfile --prefer-offline', npm: 'npm ci', yarn: 'yarn install --immutable', bun: 'bun install --frozen-lockfile', pip: 'pip install -r requirements.txt', uv: 'uv sync --frozen', unknown: null
  };
  const expected = parsed.framework === 'astro' ? [4321] : parsed.framework === 'vite' ? [5173] : parsed.framework === 'nextjs' ? [3000] : [];
  return { packageManager: parsed.pm, framework: parsed.framework, installCommand: install[parsed.pm], devCommand: parsed.scripts.dev ? `${parsed.pm === 'unknown' ? 'npm' : parsed.pm} run dev` : null, buildCommand: parsed.scripts.build ? `${parsed.pm === 'unknown' ? 'npm' : parsed.pm} run build` : null, expectedPorts: expected };
}

export async function detectProject(handle: SandboxHandle, cwd = '/workspace/repo'): Promise<ProjectDetection> {
  const result = await handle.exec({
    command: DETECTION_SCRIPT,
    cwd, timeoutMs: 30_000, outputLimitBytes: 100_000, sessionId: 'system', networkPolicy: 'deny_all'
  });
  if (result.exitCode !== 0) return { ...UNKNOWN_DETECTION };
  return parseDetection(result.stdout);
}
