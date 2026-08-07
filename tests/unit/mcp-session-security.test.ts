import { describe, expect, it } from 'vitest';
import { ForgeError } from '@forge/core';
import { assertPublicHost, classifyCommand } from '@forge/policy';
import { assertTaskTransition, isTerminalTaskState } from '@forge/task-core';
import type { TaskState } from '@forge/task-core';
import { forgeTools } from '@forge/mcp-core';
import { mayAutoApproveShell } from '../../apps/forge-edge-gateway/src/handlers/helpers';

// These tests cover the security-relevant primitives that mcp-session.ts wires
// into its handlers. The handler bodies themselves need a full Worker harness
// (DO stubs, R2, D1) to run, so they are exercised at the primitive level here:
// the wiring in mcp-session.ts is a thin, reviewed adapter over these units.

describe('SSRF guard (forge_screenshot URL egress)', () => {
  // Mirrors mcp-session.ts: new URL(input.url).hostname with IPv6 brackets stripped.
  const hostOf = (url: string) => new URL(url).hostname.replace(/^\[|\]$/g, '');

  const blocked = [
    'http://169.254.169.254/latest/meta-data/',   // cloud metadata IP
    'http://127.0.0.1:8080/',                       // loopback
    'http://localhost/admin',                       // localhost
    'http://10.0.0.5/',                             // private class A
    'http://192.168.1.1/',                          // private class C
    'http://172.16.0.1/',                           // private class B
    'http://[::1]/',                                // IPv6 loopback
    'http://backend.internal.local/'                // .local suffix
  ];
  for (const url of blocked) {
    it(`rejects ${url}`, () => {
      expect(() => assertPublicHost(hostOf(url))).toThrow(ForgeError);
    });
  }

  const allowed = ['https://example.com/', 'https://sub.example.co.uk/path', 'http://93.184.216.34/'];
  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(() => assertPublicHost(hostOf(url))).not.toThrow();
    });
  }

  it('the forge_screenshot schema accepts URL targets (guard is runtime, not schema)', () => {
    const screenshot = forgeTools.find((t) => t.name === 'forge_screenshot');
    expect(screenshot).toBeDefined();
    const url = (screenshot!.inputSchema as { target: { safeParse(v: unknown): { success: boolean } } }).target;
    // Schema permits any well-formed URL; the SSRF block is enforced in the handler.
    expect(url.safeParse('http://169.254.169.254/').success).toBe(true);
  });
});

describe('nuanced shell auto-approve gating', () => {
  const productionAutoApprove = { FORGE_AUTO_APPROVE_SHELL: 'true' } as const;

  it('dependency_install is gated (allowed + approvalRequired) and auto-approvable', () => {
    const decision = classifyCommand('npm install left-pad', 'development');
    expect(decision.allowed).toBe(true);
    expect(decision.approvalRequired).toBe(true);
    expect(mayAutoApproveShell(productionAutoApprove, decision.classification, 'development')).toBe(true);
  });

  it('network egress under unrestricted_with_approval is NEVER auto-approved', () => {
    const decision = classifyCommand('curl https://example.com', 'unrestricted_with_approval');
    expect(decision.allowed).toBe(true);
    expect(decision.approvalRequired).toBe(true);
    // Even with the operator flag on, this must require a real human approval.
    expect(mayAutoApproveShell(productionAutoApprove, decision.classification, 'unrestricted_with_approval')).toBe(false);
  });

  it('destructive commands are never silently auto-approved', () => {
    const decision = classifyCommand('rm -rf /workspace/repo', 'development');
    expect(decision.classification).toBe('destructive');
    expect(mayAutoApproveShell(productionAutoApprove, decision.classification, 'development')).toBe(false);
  });

  it('auto-approve is off entirely when the operator flag is off', () => {
    const decision = classifyCommand('pnpm add react', 'development');
    expect(mayAutoApproveShell({ FORGE_AUTO_APPROVE_SHELL: 'false' }, decision.classification, 'development')).toBe(false);
  });

  it('never silently auto-approves a shell evaluator, even if its class is configured', () => {
    const decision = classifyCommand("eval 'git push origin HEAD'", 'development');
    expect(decision).toMatchObject({ classification: 'shell_evaluation', approvalRequired: true });
    expect(mayAutoApproveShell({
      FORGE_AUTO_APPROVE_SHELL: 'true',
      FORGE_AUTO_APPROVE_SHELL_CLASSES: 'dependency_install,shell_evaluation'
    }, decision.classification, 'development')).toBe(false);
  });
});

describe('task-state transition enforcement (forge_task_finish)', () => {
  it('flags terminal tasks so the handler can reject re-finishing them', () => {
    // assertTaskTransition short-circuits when from === to, so finishing an
    // already-`complete` task with `complete` would slip through it. The handler
    // therefore gates on isTerminalTaskState FIRST; assertTaskTransition is
    // defense-in-depth for the differing-state cases below.
    expect(isTerminalTaskState('complete')).toBe(true);
    expect(isTerminalTaskState('cancelled')).toBe(true);
    expect(isTerminalTaskState('coding')).toBe(false);
  });

  it('rejects a terminal task transitioning to a different terminal outcome', () => {
    expect(() => assertTaskTransition('complete', 'failed')).toThrow(ForgeError);
    expect(() => assertTaskTransition('cancelled', 'complete')).toThrow(ForgeError);
  });

  it('rejects an illegal transition (planning -> complete)', () => {
    expect(() => assertTaskTransition('planning', 'complete')).toThrow(ForgeError);
  });

  it('permits a legal terminal transition (reviewing -> complete)', () => {
    expect(() => assertTaskTransition('reviewing', 'complete')).not.toThrow();
  });

  it('permits cancel/fail from active states', () => {
    expect(() => assertTaskTransition('coding', 'cancelled')).not.toThrow();
    expect(() => assertTaskTransition('coding', 'failed')).not.toThrow();
  });
});

describe('bounded inputs (forge_read aggregate ceiling)', () => {
  // Replicates the mcp-session.ts ceiling: paths.length * max_bytes must not
  // exceed MAX_TOTAL_READ_BYTES, independent of the per-file schema bound.
  const MAX_TOTAL_READ_BYTES = 2_000_000;
  const withinCeiling = (paths: number, maxBytes: number) => paths * maxBytes <= MAX_TOTAL_READ_BYTES;

  it('rejects the schema-maximal batch (20 paths x 500KB = 10MB)', () => {
    expect(withinCeiling(20, 500_000)).toBe(false);
  });

  it('permits a reasonable batch (10 paths x 100KB = 1MB)', () => {
    expect(withinCeiling(10, 100_000)).toBe(true);
  });

  it('the schema still allows the maximal per-file / path counts (ceiling is runtime)', () => {
    const read = forgeTools.find((t) => t.name === 'forge_read');
    const schema = read!.inputSchema as {
      max_bytes: { safeParse(v: unknown): { success: boolean } };
      paths: { safeParse(v: unknown): { success: boolean } };
    };
    expect(schema.max_bytes.safeParse(500_000).success).toBe(true);
    expect(schema.paths.safeParse(Array.from({ length: 20 }, () => '/workspace/x')).success).toBe(true);
  });
});
