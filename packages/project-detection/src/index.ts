import type { SandboxHandle } from '@forge/sandbox-core';
import {
  FORGE_CONFIG_FILENAMES,
  normalizePreviewCwd,
  parseForgeConfig,
  type ForgePreviewConfig
} from './forge-config.js';

export { FORGE_CONFIG_FILENAMES, normalizePreviewCwd, parseForgeConfig } from './forge-config.js';
export type { ForgePreviewConfig } from './forge-config.js';

export interface ProjectDetection {
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | 'pip' | 'uv' | 'unknown';
  framework: string | null;
  installCommand: string | null;
  // Lenient install used only if `installCommand` (which pins to the committed
  // lockfile) fails because the lockfile is out of sync with the manifest — a
  // common cause is an `overrides`/`resolutions` mismatch. null when the manager
  // has no meaningfully different lenient mode (e.g. pip).
  installFallbackCommand: string | null;
  devCommand: string | null;
  buildCommand: string | null;
  expectedPorts: number[];
  /** Absolute executor cwd for the configured or detected dev server. */
  devCwd?: string;
  /** Absolute executor cwd used for dependency installation. */
  installCwd?: string;
  /** Lockfile name relative to installCwd, when one was detected. */
  lockfilePath?: string | null;
  /** Explicit repository preview settings, when a Forge config supplied them. */
  previewConfig?: ForgePreviewConfig | null;
  previewConfigFile?: string | null;
  previewConfigError?: string | null;
}

const UNKNOWN_DETECTION: ProjectDetection = {
  packageManager: 'unknown',
  framework: null,
  installCommand: null,
  installFallbackCommand: null,
  devCommand: null,
  buildCommand: null,
  expectedPorts: [],
  devCwd: '/workspace/repo',
  installCwd: '/workspace/repo',
  lockfilePath: null,
  previewConfig: null,
  previewConfigFile: null,
  previewConfigError: null
};

// The detection probe: a single node script (heredoc) that inspects the checkout
// and prints one JSON line of project metadata. Exported so the provisioner
// can fold it into a larger combined exec and reuse `parseDetection` on the output.
export const DETECTION_SCRIPT = `node - <<'NODE'
const fs=require('fs');
const path=require('path');
const exists=(p)=>fs.existsSync(p);
const read=(p)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return null}};
const readConfig=()=>{
  for(const file of ${JSON.stringify(FORGE_CONFIG_FILENAMES)}){
    if(!exists(file))continue;
    try{return {file,value:JSON.parse(fs.readFileSync(file,'utf8'))}}catch{return {file,value:null,error:'Forge config is not valid JSON.'}}
  }
  return {file:null,value:null};
};
const safeCwd=(value)=>{
  if(typeof value!=='string'||!value.trim())return '.';
  const raw=value.trim().replaceAll('\\\\','/');
  if(raw.length>500||raw.startsWith('/')||/[\\u0000-\\u001f\\u007f]/u.test(raw))return '.';
  const parts=[];
  for(const part of raw.split('/')){if(!part||part==='.')continue;if(part==='..')return '.';parts.push(part)}
  return parts.join('/')||'.';
};
const config=readConfig();
const preview=config.value&&typeof config.value==='object'&&config.value.preview&&typeof config.value.preview==='object'?config.value.preview:null;
const previewCwd=safeCwd(preview?.cwd);
const readAt=(relative)=>read(path.join(previewCwd,relative))||read(relative);
const lockfiles=[['pnpm','pnpm-lock.yaml'],['bun','bun.lock'],['bun','bun.lockb'],['yarn','yarn.lock'],['npm','package-lock.json'],['uv','uv.lock'],['pip','requirements.txt']];
const findManager=(dir)=>{for(const [pm,file] of lockfiles)if(exists(path.join(dir,file)))return {pm,lockfile:file};return {pm:'unknown',lockfile:null}};
const rootManager=findManager('.');
const previewManager=previewCwd==='.'?rootManager:findManager(previewCwd);
const manager=rootManager.pm!=='unknown'?rootManager:previewManager;
const pkg=readAt('package.json')||{};
const all={...(pkg.dependencies||{}),...(pkg.devDependencies||{})};
let framework=null;
for(const [name,label] of [['astro','astro'],['next','nextjs'],['vite','vite'],['@redwoodjs/core','redwoodjs'],['rwsdk','redwoodsdk'],['nuxt','nuxt'],['svelte','sveltekit']]) if(all[name]){framework=label;break}
const scripts=pkg.scripts&&typeof pkg.scripts==='object'?pkg.scripts:{};
console.log(JSON.stringify({pm:manager.pm,framework,scripts,installCwd:rootManager.pm!=='unknown'?'.':previewCwd,lockfilePath:manager.lockfile,forgeConfig:config.value,forgeConfigFile:config.file,forgeConfigError:config.error||null}));
NODE`;

// Pure parser for the detection probe's stdout. Returns the unknown default when
// the output is missing or unparseable (mirrors the exec exitCode!==0 fallback).
export function parseDetection(stdout: string): ProjectDetection {
  let parsed: {
    pm: ProjectDetection['packageManager'];
    framework: string | null;
    scripts: Record<string, string>;
    installCwd?: string;
    lockfilePath?: string | null;
    forgeConfig?: unknown;
    forgeConfigFile?: string | null;
    forgeConfigError?: string | null;
  };
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...UNKNOWN_DETECTION };
    parsed = value as typeof parsed;
  } catch {
    return { ...UNKNOWN_DETECTION };
  }
  const packageManager: ProjectDetection['packageManager'] = ['pnpm', 'npm', 'yarn', 'bun', 'pip', 'uv'].includes(parsed.pm)
    ? parsed.pm
    : 'unknown';
  const install: Record<ProjectDetection['packageManager'], string | null> = {
    pnpm: 'pnpm install --frozen-lockfile --prefer-offline', npm: 'npm ci', yarn: 'yarn install --immutable', bun: 'bun install --frozen-lockfile', pip: 'pip install -r requirements.txt', uv: 'uv sync --frozen', unknown: null
  };
  // Lenient fallback: drop the frozen/immutable pin so an out-of-sync lockfile
  // (a classic `overrides` mismatch) does not hard-fail the whole bootstrap. pip
  // has no distinct lenient mode, so it has no fallback.
  const installFallback: Record<ProjectDetection['packageManager'], string | null> = {
    pnpm: 'pnpm install --no-frozen-lockfile --prefer-offline', npm: 'npm install', yarn: 'yarn install', bun: 'bun install', pip: null, uv: 'uv sync', unknown: null
  };
  const configResult = parsed.forgeConfigError
    ? { preview: null, error: parsed.forgeConfigError }
    : parseForgeConfig(parsed.forgeConfig);
  const config = configResult.preview;
  const runner = packageManager === 'unknown' ? 'npm' : packageManager;
  const expected = config?.port
    ? [config.port]
    : parsed.framework === 'astro'
      ? [4321]
      : (parsed.framework === 'vite' || parsed.framework === 'sveltekit')
        ? [5173]
        : (parsed.framework === 'nextjs' || parsed.framework === 'nuxt' || parsed.framework === 'redwoodjs')
          ? [3000]
          : [];
  const devCommand = config?.command ?? (parsed.scripts?.dev ? `${runner} run dev` : null);
  const devCwd = config?.cwd && config.cwd !== '.' ? `/workspace/repo/${config.cwd}` : '/workspace/repo';
  const installRelative = typeof parsed.installCwd === 'string' ? normalizePreviewCwd(parsed.installCwd) : null;
  const installCwd = installRelative && installRelative !== '.' ? `/workspace/repo/${installRelative}` : '/workspace/repo';
  const lockfilePath = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'uv.lock', 'requirements.txt'].includes(parsed.lockfilePath ?? '')
    ? parsed.lockfilePath
    : null;
  return {
    packageManager,
    framework: parsed.framework ?? null,
    installCommand: install[packageManager],
    installFallbackCommand: installFallback[packageManager],
    devCommand,
    buildCommand: parsed.scripts?.build ? `${runner} run build` : null,
    expectedPorts: expected,
    devCwd,
    installCwd,
    lockfilePath,
    previewConfig: config,
    previewConfigFile: parsed.forgeConfigFile ?? null,
    previewConfigError: configResult.error ?? null
  };
}

export async function detectProject(handle: SandboxHandle, cwd = '/workspace/repo'): Promise<ProjectDetection> {
  const result = await handle.exec({
    command: DETECTION_SCRIPT,
    cwd, timeoutMs: 30_000, outputLimitBytes: 100_000, sessionId: 'system', networkPolicy: 'deny_all'
  });
  if (result.exitCode !== 0) return { ...UNKNOWN_DETECTION };
  return parseDetection(result.stdout);
}
