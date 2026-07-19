import { describe, expect, it } from 'vitest';
import { analyzeStructureHealth } from '@forge/browser-core';

function heading(name: string, level?: number) {
  return { role: 'heading', name, level };
}

describe('structure health analysis', () => {
  it('reports a clean tree with no heading defects', () => {
    const tree = {
      role: 'RootWebArea',
      name: 'Home',
      children: [
        heading('Welcome', 1),
        { role: 'paragraph', name: 'Intro copy' },
        heading('Features', 2),
        { role: 'paragraph', name: 'Feature copy' }
      ]
    };
    const health = analyzeStructureHealth(tree);
    expect(health.headingCount).toBe(2);
    expect(health.clean).toBe(true);
    expect(health.findingCount).toBe(0);
  });

  it('flags title-on-title stacks with no content between headings', () => {
    const tree = {
      role: 'main',
      children: [heading('Dashboard', 1), heading('Overview', 2), heading('Summary', 3)]
    };
    const health = analyzeStructureHealth(tree);
    expect(health.clean).toBe(false);
    // Second and third headings each stack on the one above.
    expect(health.countsByKind.stacked_headings).toBe(2);
    expect(health.findings.some((f) => f.kind === 'stacked_headings')).toBe(true);
  });

  it('does not flag a stack once meaningful content separates the headings', () => {
    const tree = {
      role: 'main',
      children: [
        heading('Dashboard', 1),
        { role: 'link', name: 'Go to reports' },
        heading('Overview', 2)
      ]
    };
    const health = analyzeStructureHealth(tree);
    expect(health.countsByKind.stacked_headings).toBe(0);
  });

  it('treats structural containers as transparent, not as content', () => {
    const tree = {
      role: 'RootWebArea',
      children: [
        heading('Report', 1),
        { role: 'generic', name: '', children: [{ role: 'group', children: [] }] },
        heading('Report details', 2)
      ]
    };
    const health = analyzeStructureHealth(tree);
    // A generic/group wrapper with no real content must not hide the stack, and
    // the repeated wording is a duplicate.
    expect(health.countsByKind.stacked_headings).toBe(1);
    expect(health.countsByKind.duplicate_heading).toBe(1);
  });

  it('flags empty headings', () => {
    const tree = { role: 'main', children: [heading('   ', 1), { role: 'paragraph', name: 'x' }] };
    const health = analyzeStructureHealth(tree);
    expect(health.countsByKind.empty_heading).toBe(1);
  });

  it('flags duplicated and nested heading text', () => {
    const tree = {
      role: 'main',
      children: [
        heading('Pricing', 1),
        { role: 'paragraph', name: 'copy' },
        heading('Pricing plans', 2)
      ]
    };
    const health = analyzeStructureHealth(tree);
    expect(health.countsByKind.duplicate_heading).toBe(1);
  });

  it('flags skipped heading levels', () => {
    const tree = {
      role: 'main',
      children: [
        heading('Title', 1),
        { role: 'paragraph', name: 'copy' },
        heading('Deep', 4)
      ]
    };
    const health = analyzeStructureHealth(tree);
    expect(health.countsByKind.heading_level_skip).toBe(1);
  });

  it('handles missing, empty, and array-rooted trees without throwing', () => {
    expect(analyzeStructureHealth(undefined).headingCount).toBe(0);
    expect(analyzeStructureHealth(null).clean).toBe(true);
    const arrayTree = [heading('A', 1), heading('B', 2)];
    expect(analyzeStructureHealth(arrayTree).countsByKind.stacked_headings).toBe(1);
  });
});
