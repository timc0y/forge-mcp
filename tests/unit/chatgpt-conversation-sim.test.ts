import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXECUTOR_PROVISIONING_NEXT_STEP,
  findActiveDependencyInstall,
  ForgeApplicationService,
  OBSERVATIONAL_WAIT_MS,
  observationalWaitNextStep
} from '@forge/application';
import { forgeTools } from '@forge/mcp-core';
import { classifyCommand } from '@forge/policy';
import { FORGE_MCP_INSTRUCTIONS, FORGE_PROMPT_HINTS } from '../../apps/forge-edge-gateway/src/mcp-guidance';
import { parseWorkspaceAddress, resolveWorkspaceId } from '../../apps/forge-edge-gateway/src/workspace-resolve';
import {
  isWranglerDeployCommand,
  workspaceAddress,
  wranglerShellDeployNextStep
} from '../../apps/forge-edge-gateway/src/handlers/helpers';
import type { Env } from '../../apps/forge-edge-gateway/src/env';
import type { SandboxHandle, SandboxProvider } from '@forge/sandbox-core';

/**
 * Simulated ChatGPT conversations: correct order, wrong order, and edge cases.
 * Each case is user → agent tool sequence → Forge reply the agent must not misread.
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

function seededService(state: 'ready' | 'destroyed' | 'requested' = 'ready') {
  const service = new ForgeApplicationService(new FakeProvider());
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
  record.workspace.state = state;
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

function envWith(occupants: Array<{ workspaceId: string; owner?: string; repo?: string; branch?: string | null; state?: string }>) {
  return {
    FORGE_SLOT_TTL_MINUTES: '240',
    METADATA: {
      prepare() {
        const statement: Record<string, unknown> = {
          bind: () => statement,
          all: async () => ({
            results: occupants.map((occupant, index) => ({
              slot: index + 1,
              workspace_id: occupant.workspaceId,
              tenant_id: 'ten_a',
              claimed_at: new Date().toISOString(),
              state: occupant.state ?? 'ready',
              updated_at: new Date().toISOString(),
              repository: occupant.owner && occupant.repo ? `${occupant.owner}/${occupant.repo}` : null,
              current_branch: occupant.branch === undefined ? null : occupant.branch
            }))
          }),
          first: async () => null,
          run: async () => ({ meta: { changes: 0 } })
        };
        return statement;
      }
    }
  } as unknown as Env;
}

function sourceMentions(rel: string, pattern: RegExp): boolean {
  return pattern.test(readFileSync(join(process.cwd(), rel), 'utf8'));
}

describe('ChatGPT conversation simulations', () => {
  it('Conv A — install wait: agent must not attempt a 10-minute single wait', async () => {
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
    expect(reused.next_step).toBe(observationalWaitNextStep(processId, { alreadyRunning: true }));
    expect(reused.next_step).not.toMatch(/600000/);
    expect(reused.next_step).toMatch(/at most 30000/);
    expect(observationalWaitNextStep(processId)).toMatch(new RegExp(`at most ${OBSERVATIONAL_WAIT_MS}`));
  });

  it('Conv B — first shell on lazy workspace: steer poll-get, forbid second workspace', () => {
    expect(EXECUTOR_PROVISIONING_NEXT_STEP).toMatch(/Do not create a second workspace/);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/never create a second workspace/);
    expect(FORGE_MCP_INSTRUCTIONS).not.toMatch(/get once, then retry/);
  });

  it('Conv C — source guidance never advertises unreachable wait budgets', () => {
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
        if (/z\.number|max\(|default\(|timeoutMs:/u.test(match[0])) continue;
        if (/Call forge_process_wait|already running|large installs/u.test(match[0])) {
          offences.push(`${rel}: ${match[0].slice(0, 120)}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('Conv D — UI iterate prompt still requires screenshots before the next edit', () => {
    const hint = FORGE_PROMPT_HINTS['iterate-ui']({ repository: 'o/r', change: 'tighten hero' });
    expect(hint).toMatch(/forge_preview|forge_review/);
    expect(hint).toMatch(/Inspect every screenshot/);
  });

  it('Conv E — resume after compression must not open a duplicate workspace', () => {
    const hint = FORGE_PROMPT_HINTS['resume-task']({ task_id: 'task_abc', repository: 'o/r' });
    expect(hint).toMatch(/do not forge_workspace_create a duplicate/i);
  });

  it('Conv F — plan work must stay container-free', () => {
    const hint = FORGE_PROMPT_HINTS['plan-work']({ repository: 'o/r', goal: 'add billing' });
    expect(hint).toMatch(/do not allocate an executor/i);
    expect(hint).not.toMatch(/forge_shell/);
  });

  it('Conv G — wrong order: edit/shell before create steers create, not inventing a branch', async () => {
    // User: "fix the typo in README"
    // Bad agent: forge_edit with no workspace open
    await expect(
      resolveWorkspaceId(envWith([]), { tenantId: 'ten_a', projectId: 'prj_a' }, {})
    ).rejects.toMatchObject({
      message: expect.stringMatching(/forge_workspace_create first[\s\S]*do not invent a branch name/i)
    });
  });

  it('Conv H — wrong order: ambiguous owner/repo after duplicate creates forbids another create', async () => {
    // User: "continue" after agent already opened two workspaces
    await expect(
      resolveWorkspaceId(envWith([
        { workspaceId: 'ws_aaaaaaaaaaaaaaaaaaaaaaaaaa', owner: 'timc0y', repo: 'demo', branch: 'forge/one' },
        { workspaceId: 'ws_bbbbbbbbbbbbbbbbbbbbbbbbbb', owner: 'timc0y', repo: 'demo', branch: 'forge/two' }
      ]), { tenantId: 'ten_a', projectId: 'prj_a' }, parseWorkspaceAddress('timc0y/demo'))
    ).rejects.toMatchObject({
      message: expect.stringMatching(/do not forge_workspace_create a duplicate/i)
    });
  });

  it('Conv I — wrong order: tools after destroy steer recreate, not permission inventions', async () => {
    const { service, record } = seededService('destroyed');
    await expect(service.gitStatus(record)).rejects.toMatchObject({
      code: 'FORGE_WORKSPACE_NOT_READY',
      message: expect.stringMatching(/destroyed[\s\S]*forge_workspace_create[\s\S]*old workspace_id/i)
    });
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/After destroy, forge_workspace_create again/);
  });

  it('Conv J — wrong order: merge then keep editing is forbidden by merge next_step', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /do not forge_edit this branch further for this submission/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /Call forge_workspace_destroy when done/
      )
    ).toBe(true);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/After forge_merge, do not edit that branch further/);
  });

  it('Conv K — wrong order: forge_start while workspace live steers reuse', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /A workspace is already open for/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /do not forge_workspace_create another one/
      )
    ).toBe(true);
    const start = forgeTools.find((tool) => tool.name === 'forge_start');
    expect(start?.description).toMatch(/reuse/i);
  });

  it('Conv L — wrong order: second forge_workspace_create for same repo is refused', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /A live workspace already covers/
      )
    ).toBe(true);
    const create = forgeTools.find((tool) => tool.name === 'forge_workspace_create');
    expect(create?.description).toMatch(/Refuses a second live workspace/);
  });

  it('Conv M — wrong order: preview before deps / stale preview_id', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/execution.ts',
        /If dependencies are missing call forge_deps_install/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/workspace-coordinator.ts',
        /Call forge_preview again without a preview_id/
      )
    ).toBe(true);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/Omit stale preview_id/);
  });

  it('Conv N — wrong order: process_wait with invented process_id', () => {
    expect(
      sourceMentions(
        'packages/application/src/managed-processes.ts',
        /do not invent process ids/
      )
    ).toBe(true);
  });

  it('Conv O — wrong order: merge with empty diff steers edit first', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /Call forge_files_read → forge_edit/
      )
    ).toBe(true);
  });

  it('Conv P — instructions name the default order and the forbidden inversions', () => {
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/forge_task_create[\s\S]*forge_workspace_create[\s\S]*forge_edit[\s\S]*forge_merge/);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/Never forge_edit\/shell\/preview\/merge before forge_workspace_create/);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/never forge_workspace_create a second time/i);
  });

  it('Conv Q — multi-turn UI: truncated read must not license whole-file overwrite', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /isCompleteRead && !result\.truncated/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /never rewrite the whole file via content from a truncated read/
      )
    ).toBe(true);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/Truncated forge_files_read/);
  });

  it('Conv R — multi-turn edit: FORGE_FILE_CONFLICT steers re-read + fresh key', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /fresh idempotency_key — do not retry the same replace payload/
      )
    ).toBe(true);
  });

  it('Conv S — multi-turn PR: re-calling forge_merge while pending replays receipt', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /Already submitted — echo only submission_receipt/
      )
    ).toBe(true);
    const merge = forgeTools.find((tool) => tool.name === 'forge_merge');
    expect(merge?.description).toMatch(/Do not call again while the same submission is pending/);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/do not poll or re-call forge_merge/);
  });

  it('Conv T — reconnect: task_create keeps task_id; resume forbids duplicate workspace', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/tasks.ts',
        /Keep this task_id for the session/
      )
    ).toBe(true);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/Keep task_id/);
  });

  it('Conv U — approval pending: stop and echo URL, do not poll', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/github.ts',
        /do not poll forge_pr or forge_merge/
      )
    ).toBe(true);
  });

  it('Conv V — workspace_get defaults to compact for ChatGPT context', () => {
    const get = forgeTools.find((tool) => tool.name === 'forge_workspace_get');
    expect(get?.description).toMatch(/Defaults to compact:true/);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /input\.compact !== false/
      )
    ).toBe(true);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/forge_workspace_get defaults to compact/i);
  });

  it('Conv W — shell/preview while install runs is refused; wait the same process', () => {
    const { record } = seededService();
    const processId = 'proc_sim_install_race';
    record.processes[processId] = {
      command: 'pnpm install --frozen-lockfile',
      startedAt: new Date().toISOString(),
      mutatesFilesystem: true
    };
    expect(findActiveDependencyInstall(record)?.processId).toBe(processId);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/workspace-coordinator.ts',
        /assertNoActiveDependencyInstall/
      )
    ).toBe(true);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/only wait\/logs\/list\/stop/);
  });

  it('Conv X — process_stop mid-install steers a single reinstall, not two', () => {
    expect(
      sourceMentions(
        'packages/application/src/managed-processes.ts',
        /never start two installs/
      )
    ).toBe(true);
  });

  it('Conv Y — context_get / diff_metadata steer read-before-edit and real field names', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /do not invent file contents from paths alone/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /Inspect riskAreas and suggestedHunks/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /suggestedChecks/
      )
    ).toBe(false);
  });

  it('Conv Z — multi-turn bugfix: edit next_step names diff_metadata before merge', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /forge_diff_metadata before forge_merge/
      )
    ).toBe(true);
  });

  it('Conv AA — spiral: shell sed/redirect is refused; durabilityNextStep forces forge_edit', () => {
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/Save = forge_edit only/);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/Never shell redirects, sed -i, git add\/commit\/push/);
    expect(classifyCommand('sed -i "s/a/b/" README.md', 'development').allowed).toBe(false);
    expect(classifyCommand('echo x > README.md', 'development').allowed).toBe(false);
    expect(
      sourceMentions(
        'packages/application/src/managed-processes.ts',
        /Do not treat exit 0 as saved/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/execution.ts',
        /Otherwise continue with forge_shell; the same executor session retains/
      )
    ).toBe(false);
  });

  it('Conv AB — spiral: git commit/add in shell is prohibited like push', () => {
    expect(classifyCommand('git commit -m "fix"', 'development')).toMatchObject({
      classification: 'prohibited',
      allowed: false
    });
    expect(classifyCommand('git add .', 'development')).toMatchObject({
      classification: 'prohibited',
      allowed: false
    });
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/git add\/commit\/push/);
  });

  it('Conv AC — spiral: missing deps still advertise forge_edit, not shell-only authoring', () => {
    expect(
      sourceMentions(
        'packages/application/src/managed-processes.ts',
        /'forge_files_read',\s*'forge_edit',\s*'forge_deps_install'/
      )
    ).toBe(true);
  });

  it('Conv AD — activity log is D1 only; no PostHog remnants', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/live-dashboard.ts',
        /Complete activity log/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/env.ts',
        /POSTHOG|posthog/
      )
    ).toBe(false);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/tool-call-log.ts',
        /hashArgs/
      )
    ).toBe(true);
  });

  it('Conv AE — Φ-gate refuses zero-progress success spirals', () => {
    expect(
      sourceMentions(
        'packages/application/src/progress-potential.ts',
        /Discrete Lyapunov/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'packages/application/src/progress-potential.ts',
        /PROGRESS_VERIFY_BUDGET/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'packages/application/src/progress-potential.ts',
        /extendWitnessChain/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/mcp-session.ts',
        /withProgressPotential/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/mcp-session.ts',
        /phiFromReceipt/
      )
    ).toBe(true);
  });

  it('Conv AF — URL review exposes real screenshot handles while other capture paths do not invent them', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/review-artifacts.ts',
        /screenshot: cell\.screenshot/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/execution.ts',
        /no screenshot\.artifactId field/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/review-artifacts.ts',
        /retrieve the listed screenshot\.artifactId values/
      )
    ).toBe(true);
  });

  it('Conv AG — workspace_id alias is accepted as workspace', () => {
    expect(workspaceAddress({ workspace_id: 'ws_aaaaaaaaaaaaaaaaaaaaaaaaaa' })).toEqual({
      workspace: 'ws_aaaaaaaaaaaaaaaaaaaaaaaaaa'
    });
    expect(workspaceAddress({ workspace: 'owner/repo#forge/x', workspace_id: 'ws_ignored' })).toEqual({
      workspace: 'owner/repo#forge/x'
    });
  });

  it('Conv AH — blocked merge does not invite inventing force:true', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /Do not invent force:true/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /Fix these, or pass force:true with a reason to merge anyway/
      )
    ).toBe(false);
  });

  it('Conv AI — resume after dead workspace surfaces unavailable guidance', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/tasks.ts',
        /workspace_unavailable: true/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/tasks.ts',
        /remembered workspace is unavailable/
      )
    ).toBe(true);
  });

  it('Conv AJ — observer_activity carries lazy stop-polling / cross-tool storm guidance', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/system.ts',
        /Alternating observer_workspace and observer_activity/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/system.ts',
        /forge_observer_activity does not start the executor/
      )
    ).toBe(true);
  });

  it('Conv AK — wrangler via forge_shell steers to forge_deploy receipt', () => {
    expect(isWranglerDeployCommand('npx wrangler deploy')).toBe(true);
    expect(isWranglerDeployCommand('npx wrangler deploy --dry-run')).toBe(false);
    expect(wranglerShellDeployNextStep()).toMatch(/deploy_receipt\.verified_url/);
    expect(wranglerShellDeployNextStep()).toMatch(/Do not invent a workers\.dev URL/);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/execution.ts',
        /Retry forge_deploy with the same idempotency_key/
      )
    ).toBe(true);
  });

  it('Conv AL — review preview capacity does not default to silent diff-only approve', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/review-preview.ts',
        /explicitly accepts a diff-only review/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/review-preview.ts',
        /approve on the diff alone/
      )
    ).toBe(false);
  });

  it('Conv AM — destroy then continue refuses the old workspace_id', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/helpers.ts',
        /liveControlPlaneCoordinator/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /do not retry tools against this workspace_id/
      )
    ).toBe(true);
    expect(FORGE_MCP_INSTRUCTIONS).toMatch(/After destroy, forge_workspace_create again/);
  });

  it('Conv AN — processless create operations complete instead of accepted-forever', async () => {
    const { service, record } = seededService('requested');
    const operationId = Object.values(record.idempotency)[0]?.operationId;
    expect(operationId).toBeTruthy();
    const op = await service.operationGet(record, operationId!);
    expect(op.status).toBe('completed');
    expect(op).toMatchObject({ stop_polling: true });
    expect(String(op.next_step)).toMatch(/Do not keep polling forge_operation_get/);
    expect(op.allowedNextActions).toEqual(expect.arrayContaining(['forge_files_read', 'forge_edit']));
  });

  it('Conv AO — nested files_list paths stay repo-relative', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/github-repository.ts',
        /Always repo-relative so forge_files_read/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /Do not strip the/
      )
    ).toBe(true);
  });

  it('Conv AP — forge_start with live workspace does not cut a stray branch', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /Detect live occupants \*before\* `createBranchRef`|cut nothing; reuse the live address|do not cut a fresh forge\/\* branch/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /was still cut on GitHub if you later need a fresh workspace/
      )
    ).toBe(false);
  });

  it('Conv AQ — workspace_create ref is optional and falls back from main', () => {
    const create = forgeTools.find((tool) => tool.name === 'forge_workspace_create');
    const ref = (create?.inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>).ref;
    expect(ref.safeParse(undefined).success).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /omit ref to use the repository default branch/
      )
    ).toBe(true);
  });

  it('Conv AR — docs-only edits skip mandatory forge_shell tests', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /Docs-only change — skip forge_shell tests/
      )
    ).toBe(true);
  });

  it('Conv AS — forge_merge does not claim an opened PR URL', () => {
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /pr_url: null/
      )
    ).toBe(true);
    expect(
      sourceMentions(
        'apps/forge-edge-gateway/src/handlers/repository-workspace.ts',
        /not an opened pull-request URL yet/
      )
    ).toBe(true);
  });
});
