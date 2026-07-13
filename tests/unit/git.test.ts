import { describe, expect, it } from 'vitest';
import { parseReceivePackCommands, assertReceivePackScope } from '../../packages/git-core/src/index';

function pkt(value: string): string {
  return `${(Buffer.byteLength(value) + 4).toString(16).padStart(4, '0')}${value}`;
}

describe('Git receive-pack scope', () => {
  it('parses and accepts only the approved branch and commit', () => {
    const commit = 'a'.repeat(40);
    const bytes = new TextEncoder().encode(`${pkt(`${'0'.repeat(40)} ${commit} refs/heads/forge/tim/fix\0report-status\n`)}0000PACK`);
    const commands = parseReceivePackCommands(bytes);
    expect(commands).toEqual([{ oldCommit: '0'.repeat(40), newCommit: commit, ref: 'refs/heads/forge/tim/fix' }]);
    expect(() => assertReceivePackScope(commands, 'forge/tim/fix', commit)).not.toThrow();
    expect(() => assertReceivePackScope(commands, 'forge/tim/other', commit)).toThrow();
    expect(() => assertReceivePackScope(commands, 'forge/tim/fix', 'b'.repeat(40))).toThrow();
  });
});
