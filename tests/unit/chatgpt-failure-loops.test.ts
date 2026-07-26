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
    expect(wait.description).toMatch(/Do not restart/i);
    expect(wait.description).toMatch(/600000/);
    const schema = wait.outputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(schema.timedOut.safeParse(true).success).toBe(true);
    expect(schema.suggestedTimeoutMs.safeParse(600_000).success).toBe(true);
    expect(schema.next_step.safeParse('retry wait').success).toBe(true);
  });

  it('dependencies_install returns processId quickly and steers process_wait', () => {
    const install = tool('forge_dependencies_install');
    expect(install.description).toMatch(/processId/i);
    expect(install.description).toMatch(/do not start a second install/i);
    const schema = install.outputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(schema.status.safeParse('running').success).toBe(true);
    expect(schema.started.safeParse(true).success).toBe(true);
    expect(schema.reusedActiveProcess.safeParse(true).success).toBe(true);
    expect(schema.next_step.safeParse('Call forge_process_wait').success).toBe(true);
  });

  it('shell_exec exposes mode:read_only and process_start accepts approval_id', () => {
    const shell = tool('forge_shell_exec').inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(shell.mode.safeParse('read_only').success).toBe(true);
    const start = tool('forge_process_start').inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(start.approval_id.safeParse('apr_test').success).toBe(true);
  });

  it('operation reconcile tools exist for uncertain disconnect outcomes', () => {
    expect(tool('forge_operation_get').sideEffect).toBe('none');
    expect(tool('forge_operation_reconcile').sideEffect).toBe('none');
    expect(tool('forge_process_list').sideEffect).toBe('none');
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
