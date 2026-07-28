import { describe, expect, it } from 'vitest';
import { hoistUniformFields } from '../../apps/forge-edge-gateway/src/uniform-fields';

// Shape and values taken from the live forge_repository_list response that
// prompted this: one installation, one sync timestamp, 24 repositories.
const REPOS = [
  { owner: 'timc0y', name: 'ColmiSmartRing', visibility: 'public', default_branch: 'main', last_verified_at: '2026-07-27T10:35:28.046Z' },
  { owner: 'timc0y', name: 'EasyRoads', visibility: 'private', default_branch: 'main', last_verified_at: '2026-07-27T10:35:28.046Z' },
  { owner: 'timc0y', name: 'forge-mcp', visibility: 'private', default_branch: 'main', last_verified_at: '2026-07-27T10:35:28.046Z' }
];

describe('hoistUniformFields', () => {
  it('states a repeated value once and removes it from the rows', () => {
    const { rows, shared } = hoistUniformFields(REPOS, ['last_verified_at', 'default_branch']);

    expect(shared).toEqual({ last_verified_at: '2026-07-27T10:35:28.046Z', default_branch: 'main' });
    expect(rows.every((row) => !('last_verified_at' in row) && !('default_branch' in row))).toBe(true);
    // Anything that actually varies is untouched.
    expect(rows.map((row) => row.visibility)).toEqual(['public', 'private', 'private']);
    expect(JSON.stringify({ repositories: rows, ...shared }).length)
      .toBeLessThan(JSON.stringify({ repositories: REPOS }).length);
  });

  it('leaves a field alone when any row disagrees', () => {
    // The danger of hoisting: one differing row would be silently restated as
    // the majority value. It must stay per-row instead.
    const mixed = [...REPOS.slice(0, 2), { ...REPOS[2], default_branch: 'trunk' }];
    const { rows, shared } = hoistUniformFields(mixed, ['default_branch']);

    expect(shared).toEqual({});
    expect(rows.map((row) => row.default_branch)).toEqual(['main', 'main', 'trunk']);
  });

  it('handles an empty list and an absent key', () => {
    expect(hoistUniformFields([], ['default_branch'])).toEqual({ rows: [], shared: {} });
    expect(hoistUniformFields(REPOS, ['nope']).shared).toEqual({});
  });
});
