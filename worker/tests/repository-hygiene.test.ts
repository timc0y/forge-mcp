import { describe, expect, it } from 'vitest';
import {
  hygieneContentPreview,
  hygienePathCandidates,
  hygieneReferenceTerm,
  isHygieneQuery,
  isHygieneSourcePath
} from '../src/repository-intelligence';

describe('repository hygiene candidate discovery', () => {
  it('recognizes explicit hygiene questions', () => {
    expect(isHygieneQuery('hygiene')).toBe(true);
    expect(isHygieneQuery('dead code')).toBe(true);
    expect(isHygieneQuery('fallback code')).toBe(true);
    expect(isHygieneQuery('find legacy code')).toBe(true);
    expect(isHygieneQuery('unused code')).toBe(true);
    expect(isHygieneQuery('where is auth implemented?')).toBe(false);
  });

  it('ranks strong legacy/fallback path signals without treating generated output as source', () => {
    const candidates = hygienePathCandidates([
      { path: 'src/auth/legacy-session.ts', type: 'file', size: 10 },
      { path: 'src/api/fallback-client.ts', type: 'file', size: 10 },
      { path: 'src/current.ts', type: 'file', size: 10 },
      { path: 'dist/legacy-session.js', type: 'file', size: 10 }
    ]);
    expect(candidates.map((candidate) => candidate.path)).toEqual([
      'src/auth/legacy-session.ts',
      'src/api/fallback-client.ts'
    ]);
    expect(isHygieneSourcePath('dist/legacy-session.js')).toBe(false);
    expect(isHygieneSourcePath('src/components/LegacyCheckout.astro')).toBe(true);
    expect(isHygieneSourcePath('sections/fallback-cart.liquid')).toBe(true);
    expect(isHygieneSourcePath('migrations/0015_legacy_aliases.sql')).toBe(true);
    expect(isHygieneSourcePath('schema/storefront.graphql')).toBe(true);
    expect(isHygieneSourcePath('config/legacy-rules.yaml')).toBe(true);
  });

  it('can surface template and migration path residue', () => {
    const candidates = hygienePathCandidates([
      { path: 'src/components/legacy-checkout.astro', type: 'file', size: 10 },
      { path: 'sections/deprecated-cart.liquid', type: 'file', size: 10 },
      { path: 'migrations/0042_old-schema.sql', type: 'file', size: 10 }
    ]);

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      'sections/deprecated-cart.liquid',
      'src/components/legacy-checkout.astro',
      'migrations/0042_old-schema.sql'
    ]);
  });

  it('keeps marker neighborhoods when a large file hides compatibility code away from the start', () => {
    const content = [
      ...Array.from({ length: 70 }, (_, index) => `const line${index} = ${index};`),
      '// Deprecated fallback kept for backwards compatibility',
      'export function oldSessionAdapter() { return legacySession(); }',
      ...Array.from({ length: 70 }, (_, index) => `const tail${index} = ${index};`)
    ].join('\n');
    const preview = hygieneContentPreview(content, 1800);
    expect(preview).toContain('Deprecated fallback kept for backwards compatibility');
    expect(preview).toContain('oldSessionAdapter');
  });

  it('prefers a distinctive exported symbol as reference evidence', () => {
    const term = hygieneReferenceTerm(
      'src/auth/legacy-session.ts',
      'export function oldSessionAdapter() {}\nexport const x = 1;'
    );
    expect(term).toBe('oldSessionAdapter');
  });
});
