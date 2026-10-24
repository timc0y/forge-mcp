import { describe, expect, it } from 'vitest';
import { accessibilityOutline } from '../src/capture';

describe('accessibilityOutline', () => {
  it('keeps useful reading order and unnamed landmarks', () => {
    const result = accessibilityOutline({
      role: 'RootWebArea',
      name: 'Example',
      children: [
        { role: 'heading', name: 'Welcome', level: 1 },
        {
          role: 'navigation',
          children: [
            { role: 'link', name: 'Docs' },
            { role: 'button', name: 'Start' }
          ]
        },
        { role: 'generic', children: [{ role: 'StaticText', name: 'Useful copy' }] }
      ]
    });

    expect(result).toEqual({
      lines: [
        'RootWebArea: Example',
        '  heading level 1: Welcome',
        '  navigation',
        '    link: Docs',
        '    button: Start',
        '    StaticText: Useful copy'
      ],
      truncated: false
    });
  });

  it('caps a large tree and reports the omission', () => {
    const result = accessibilityOutline({
      role: 'RootWebArea',
      name: 'Large page',
      children: Array.from({ length: 100 }, (_, index) => ({
        role: 'link',
        name: `Link ${index + 1}`
      }))
    });

    expect(result.lines).toHaveLength(80);
    expect(result.lines[0]).toBe('RootWebArea: Large page');
    expect(result.lines[79]).toBe('  link: Link 79');
    expect(result.truncated).toBe(true);
  });
});
