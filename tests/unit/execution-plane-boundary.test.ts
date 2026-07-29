import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SESSION = readFileSync(
  new URL('../../apps/forge-edge-gateway/src/mcp-session.ts', import.meta.url),
  'utf8'
);
const WORKER = readFileSync(
  new URL('../../apps/forge-edge-gateway/src/index.ts', import.meta.url),
  'utf8'
);

function handler(name: string, next: string): string {
  const start = SESSION.indexOf(`${name}: async`);
  const end = SESSION.indexOf(`${next}: async`, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SESSION.slice(start, end);
}

describe('GitHub and executor plane boundary', () => {
  it('creates the durable branch without provisioning an executor', () => {
    const create = handler('forge_workspace_create', 'forge_workspace_get');
    expect(create).toContain('createBranchRef');
    expect(create).not.toContain('PROVISION_WORKFLOW');
  });

  it('keeps GitHub CRUD independent from lazy executor provisioning', () => {
    const list = handler('forge_files_list', 'forge_files_read');
    const read = handler('forge_files_read', 'forge_edit');
    const edit = handler('forge_edit', 'forge_diff_metadata');
    expect(list).not.toContain('.filesTree(');
    expect(read).not.toContain('.filesRead(');
    expect(edit).toContain('commitFilesToBranch');
    expect(edit).not.toContain('executorCoordinator');
  });

  it('loads the executor only for execution and never ingests its files', () => {
    const shell = handler('forge_shell', 'forge_process_logs');
    const wait = handler('forge_process_wait', 'forge_deps_install');
    expect(shell).toContain('executorCoordinator');
    expect(shell).toContain("remote_persisted: false");
    expect(wait).toContain("remote_persisted: false");
    expect(`${shell}\n${wait}`).not.toContain('ingestContainerWrites');
  });

  it('does not gate control-plane readiness on executor recovery evidence', () => {
    const ready = WORKER.slice(WORKER.indexOf("url.pathname === '/ready'"));
    expect(ready).toContain('const ready = configured;');
    expect(ready).toContain('requiredForReadiness: false');
  });
});
