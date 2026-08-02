import { describe, expect, it } from 'vitest';
import { forgeTools } from '@forge/mcp-core';

function tool(name: string) {
  const found = forgeTools.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

/**
 * Simulated ChatGPT session traps that previously caused repeated errors.
 * These are schema/contract assertions for the steered recovery paths.
 */
describe('ChatGPT failure-loop contracts', () => {
  it('process_wait documents observational timeout + suggested retry, not kill/restart', () => {
    const wait = tool('forge_process_wait');
    expect(wait.description).toMatch(/observational/i);
    expect(wait.description).toMatch(/same process_id instead of restarting/i);
    expect(wait.description).toMatch(/at most 30 seconds/i);
    expect(wait.description).not.toMatch(/600000/);
    const schema = wait.outputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(schema.timedOut.safeParse(true).success).toBe(true);
    expect(schema.suggestedTimeoutMs.safeParse(30_000).success).toBe(true);
    expect(schema.next_step.safeParse('retry wait').success).toBe(true);
  });

  it('deps_install returns processId quickly and steers process_wait', () => {
    const install = tool('forge_deps_install');
    expect(install.description).toMatch(/processId/i);
    expect(install.description).toMatch(/Do not start a second install/i);
    expect(install.description).toMatch(/bounded forge_process_wait/i);
    expect(install.description).not.toMatch(/timeout_ms >= 600000/);
    const schema = install.outputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(schema.status.safeParse('running').success).toBe(true);
    expect(schema.started.safeParse(true).success).toBe(true);
    expect(schema.reusedActiveProcess.safeParse(true).success).toBe(true);
    expect(schema.next_step.safeParse('Call forge_process_wait').success).toBe(true);
  });

  it('shell exposes mode:read_only and async for long-running managed processes', () => {
    const shell = tool('forge_shell').inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(shell.mode.safeParse('read_only').success).toBe(true);
    expect(shell.async.safeParse(true).success).toBe(true);
    expect(shell.approval_id.safeParse('apr_test').success).toBe(true);
  });

  it('operation get + process list exist for uncertain disconnect outcomes', () => {
    expect(tool('forge_operation_get').sideEffect).toBe('none');
    expect(tool('forge_process_list').sideEffect).toBe('none');
    expect(forgeTools.some((entry) => entry.name === 'forge_operation_reconcile')).toBe(false);
  });

  it('dependencyState schema never accepts null (ChatGPT schema reject loop)', () => {
    const schema = tool('forge_workspace_get').outputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(schema.dependencyState.safeParse(null).success).toBe(false);
    expect(schema.dependencyState.safeParse({
      status: 'unknown',
      reason: 'not_observed',
      usable: false
    }).success).toBe(true);
  });
});
