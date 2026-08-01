import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXECUTOR_PROVISIONING_NEXT_STEP,
  ForgeApplicationService,
  OBSERVATIONAL_WAIT_MS,
  observationalWaitNextStep
} from '@forge/application';
import { FORGE_MCP_INSTRUCTIONS, FORGE_PROMPT_HINTS } from '../../apps/forge-edge-gateway/src/mcp-guidance';
import type { SandboxHandle, SandboxProvider } from '@forge/sandbox-core';

/**
 * Simulated ChatGPT conversations that used to go wrong in production.
 *
 * Each case is a transcript-shaped script: user ask → agent tool → Forge reply
 * shape the agent must not misread. Assertions pin the steers that stop the
 * known inventions (10-minute waits, duplicate workspaces, "get once" then give up).
 */

class FakeProvider implements SandboxProvider {
  kind = 'cloudflare' as const;
  version = 'test';
  async get(): Promise<SandboxHandle> {
    return {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, artifactRefs: [] }),
      destroy: async () => undefined
    } as unknown as SandboxHandle;
  }
}

function seededService() {
  const provider = new FakeProvider();
  const service = new ForgeApplicationService(provider);
  const record = service.initializeWorkspace({
    tenantId: 'ten_00000000000000000000000000' as never,
    projectId: 'prj_00000000000000000000000000' as never,
    repository: { provider: 'github', owner: 'timc0y', name: 'demo' },
    ref: 'main',
    runtimeProfile: 'node-24',
    persistence: 'ephemeral',
    bootstrap: false,
    idempotencyKey: 'sim-seed',
    actor: { type: 'agent', id: 'chatgpt' }
  });
  record.workspace.state = 'ready';
  record.workspace.currentBranch = 'forge/sim';
  record.workspace.currentCommit = 'a'.repeat(40);
  record.detection = {
    packageManager: 'pnpm',
    installCommand: 'pnpm install --frozen-lockfile',
    installFallbackCommand: 'pnpm install',
    framework: 'vite',
    scripts: { dev: 'vite' },
    expectedPorts: [5173]
  } as never;
  return { service, record };
}

describe('ChatGPT conversation simulations', () => {
  it('Conv A — install wait: agent must not attempt a 10-minute single wait', async () => {
    // User: "install deps and run the app"
    // Agent: forge_deps_install while one is running → must observe with ≤30s waits
    const { service, record } = seededService();
    const processId = 'proc_sim_install';
    record.processes[processId] = {
      command: 'pnpm install --frozen-lockfile',
      startedAt: new Date().toISOString(),
      mutatesFilesystem: true
    };

    const reused = await service.dependenciesInstall(record, {
      networkPolicy: 'package_install',
      idempotencyKey: 'sim-install-2',
      expectedRevision: 1,
      hostSafeWaitMs: 50
    });
    expect(reused.reusedActiveProcess).toBe(true);
    expect(reused.processId).toBe(processId);
    expect(reused.next_step).toBe(
      observationalWaitNextStep(processId, { alreadyRunning: true })
    );
    expect(reused.next_step).not.toMatch(/600000/);
    expect(reused.next_step).toMatch(/at most 30000/);
    expect(reused.next_step).toMatch(/Do not start another install/);

    // Same contract the wait tool itself advertises — never a single 600s hold.
    const waitHint = observationalWaitNextStep(processId);
    expect(waitHint).not.toMatch(/600000/);
    expect(waitHint).toMatch(new RegExp(`at most ${OBSERVATIONAL_WAIT_MS}`));
  });

  it('Conv B — first shell on lazy workspace: steer poll-get, forbid second workspace', () => {
    // User: "run the tests"
    // Agent: forge_shell on requested → NOT_READY → must poll get, not forge_workspace_create
    expect(EXECUTOR_PROVISIONING_NEXT_STEP).toMatch(/forge_workspace_get/);
    expect(EXECUTOR_PROVISIONING_NEXT_STEP).toMatch(/Do not create a second workspace/);
    expect(EXECUTOR_PROVISIONING_NEXT_STEP).toMatch(/retry the same execution tool/);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/never create a second workspace/);
    expect(FORGE_MCP_INSTRUCTIONS).not.toMatch(/get once, then retry/);
    expect(FORGE_PROMPT_HINTS['start-task']({ repository: 'o/r', task: 'fix x' })).toMatch(
      /poll forge_workspace_get until ready/
    );
  });

  it('Conv C — source guidance never advertises unreachable wait budgets', () => {
    // Static sweep: any next_step / hint that still says 600000 will train ChatGPT wrong.
    const roots = [
      'packages/application/src/index.ts',
      'packages/application/src/managed-processes.ts',
      'apps/forge-edge-gateway/src/workspace-coordinator.ts',
      'apps/forge-edge-gateway/src/handlers/helpers.ts',
      'apps/forge-edge-gateway/src/mcp-guidance.ts'
    ];
    const offences: string[] = [];
    for (const rel of roots) {
      const source = readFileSync(join(process.cwd(), rel), 'utf8');
      for (const match of source.matchAll(/next_step[^;]{0,400}600000|timeout_ms[^;\n]{0,80}600000/gu)) {
        // Schema defaults for install lifetime may still say max(900000)/default(600000);
        // only agent-facing wait guidance is banned.
        if (/z\.number|max\(|default\(|timeoutMs:/u.test(match[0])) continue;
        if (/Call forge_process_wait|already running|large installs/u.test(match[0])) {
          offences.push(`${rel}: ${match[0].slice(0, 120)}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('Conv D — UI iterate prompt still requires screenshots before the next edit', () => {
    // User: "make the hero tighter"
    // Bad agent: edit → edit → edit with no evidence
    const hint = FORGE_PROMPT_HINTS['iterate-ui']({ repository: 'o/r', change: 'tighten hero' });
    expect(hint).toMatch(/forge_preview|forge_review/);
    expect(hint).toMatch(/Inspect every screenshot/);
    expect(hint).toMatch(/forge_edit/);
  });

  it('Conv E — resume after compression must not open a duplicate workspace', () => {
    // User: "continue" after ChatGPT compressed context
    const hint = FORGE_PROMPT_HINTS['resume-task']({ task_id: 'task_abc', repository: 'o/r' });
    expect(hint).toMatch(/forge_task_get/);
    expect(hint).toMatch(/mode:resume|mode: resume|mode:resume/i);
    expect(hint).toMatch(/do not forge_workspace_create a duplicate/i);
  });

  it('Conv F — plan work must stay container-free', () => {
    const hint = FORGE_PROMPT_HINTS['plan-work']({ repository: 'o/r', goal: 'add billing' });
    expect(hint).toMatch(/forge_task_create/);
    expect(hint).toMatch(/do not allocate an executor/i);
    expect(hint).not.toMatch(/forge_shell/);
    expect(hint).not.toMatch(/forge_deps_install/);
  });
});
