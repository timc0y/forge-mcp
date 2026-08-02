import { describe, expect, it } from 'vitest';
import {
  describeWorkspaceLifecycle,
  LAZY_REQUESTED_NEXT_ACTIONS
} from '../../packages/application/src/managed-processes';
import { observerRepeatDiagnostic } from '../../apps/forge-edge-gateway/src/observer-api';

describe('describeWorkspaceLifecycle', () => {
  it('names healthy lazy create instead of implying a hung provisioner', () => {
    const view = describeWorkspaceLifecycle('requested', {
      branch: 'forge/easyroads-eval',
      head: 'abcdef1234567890'
    });
    expect(view.lifecycle).toBe('lazy_control_plane');
    expect(view.executor_state).toBe('not_loaded');
    expect(view.healthy).toBe(true);
    expect(view.allowedNextActions).toEqual([...LAZY_REQUESTED_NEXT_ACTIONS]);
    expect(view.guidance).toMatch(/Do not keep polling the observer/u);
    expect(view.guidance).toMatch(/Empty processes and empty logs are expected/u);
    expect(view.durability.plane).toBe('github');
    expect(view.durability.statement).toContain('forge/easyroads-eval');
    expect(view.durability.statement).toContain('abcdef123456');
  });

  it('keeps true executor start on forge_workspace_get', () => {
    const view = describeWorkspaceLifecycle('provisioning');
    expect(view.lifecycle).toBe('executor_starting');
    expect(view.executor_state).toBe('starting');
    expect(view.allowedNextActions).toEqual(['forge_workspace_get']);
    expect(view.next_step).toMatch(/forge_workspace_get/u);
  });

  it('steers failed sessions to recreate, not poll', () => {
    const view = describeWorkspaceLifecycle('failed');
    expect(view.healthy).toBe(false);
    expect(view.lifecycle).toBe('failed');
    expect(view.allowedNextActions).toContain('forge_workspace_create');
    expect(view.guidance).toMatch(/Do not poll for recovery/u);
  });
});

describe('observerRepeatDiagnostic', () => {
  it('stays quiet on the first and second identical success', () => {
    expect(observerRepeatDiagnostic('forge_observer_workspace', 0)).toBeNull();
    expect(observerRepeatDiagnostic('forge_observer_workspace', 1)).toBeNull();
  });

  it('stops the third identical successful observer poll', () => {
    const diagnostic = observerRepeatDiagnostic('forge_observer_workspace', 2);
    expect(diagnostic).not.toBeNull();
    expect(diagnostic?.stop_polling).toBe(true);
    expect(diagnostic?.repeatedIdenticalSuccesses).toBe(3);
    expect(diagnostic?.guidance).toMatch(/3 times/u);
    expect(diagnostic?.guidance).toMatch(/lazy_control_plane|requested/u);
    expect(diagnostic?.allowedNextActions).toEqual([...LAZY_REQUESTED_NEXT_ACTIONS]);
  });
});
