import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { forgeTools } from '@forge/mcp-core';

const gatewaySrc = join(process.cwd(), 'apps/forge-edge-gateway/src');
const read = (file: string): string => readFileSync(join(gatewaySrc, file), 'utf8');

/**
 * forge_access answered can_write from `repo.permissions.push`. A repository
 * fetched with a GitHub App installation token carries no `permissions` field
 * at all — it is populated for user tokens — so the check read undefined and
 * reported can_write:false for every repository, always. Its next_step then
 * told the reader to "grant contents:write" on an installation that already
 * had it.
 *
 * The cost was not the wrong boolean. It was that the one tool built to settle
 * "is this a permissions problem?" answered yes every time, and two agents
 * spent their run troubleshooting access that was never broken.
 */
describe('forge_access proves write capability instead of inferring it', () => {
  it('never derives can_write from a repository object', () => {
    const handlers = read('handlers/repository-workspace.ts');
    const assignments = [...handlers.matchAll(/can_write:\s*([^,\n]+)/gu)].map((match) => match[1] ?? '');

    expect(assignments.length).toBeGreaterThan(0);
    for (const assignment of assignments) {
      // `.push` here would mean the repository object's permissions block, the
      // exact field an installation token never populates.
      expect(assignment, `can_write: ${assignment}`).not.toMatch(/\.push\b/u);
    }
  });

  it('takes its answer from the granted token permissions', () => {
    const github = read('github.ts');
    // The mint is the proof: GitHub refuses a write-scoped token outright when
    // the installation lacks the permission, so a token that comes back with
    // contents:write is write access demonstrated, not inferred.
    expect(github).toContain('export async function repositoryWriteProof');
    expect(github).toMatch(/permissions\.contents === 'write'/u);
    expect(read('handlers/repository-workspace.ts')).toContain('repositoryWriteProof(env, identity');
  });

  it('stops a caller re-checking access when access is fine', () => {
    const session = read('handlers/repository-workspace.ts');
    // The failure this closes: a real forge_merge fault read as a permissions
    // fault, sending the agent back round the same loop.
    expect(session).toMatch(/is NOT a permission problem/u);
  });

  it('declares the granted permissions it now reports', () => {
    const access = forgeTools.find((tool) => tool.name === 'forge_access');
    expect(Object.keys(access?.outputSchema ?? {})).toContain('granted_permissions');
  });
});
