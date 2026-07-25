import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseNumstatZ,
  planDiffPage,
  estimateFileDiffBytes,
  diffPageNote,
  type DiffFileStat
} from '../../packages/application/src/index';

/** Build the NUL-delimited form `git diff --numstat -z` actually emits. */
function numstatZ(records: string[]): string {
  return records.map((record) => `${record}\0`).join('');
}

function stat(path: string, additions = 10, deletions = 5, binary = false): DiffFileStat {
  return { path, additions, deletions, binary };
}

describe('parseNumstatZ', () => {
  it('parses ordinary records', () => {
    const files = parseNumstatZ(numstatZ(['12\t3\tsrc/a.ts', '0\t40\tsrc/b.ts']));
    expect(files).toEqual([
      { path: 'src/a.ts', additions: 12, deletions: 3, binary: false },
      { path: 'src/b.ts', additions: 0, deletions: 40, binary: false }
    ]);
  });

  it('keeps paths with spaces, quotes and non-ASCII verbatim', () => {
    // The whole reason for -z: with plain --numstat git would quote-escape
    // every one of these and we would have to unescape them correctly.
    const files = parseNumstatZ(numstatZ([
      '1\t1\tdocs/my notes.md',
      '2\t0\tsrc/say "hi".ts',
      '3\t0\tdocs/café/résumé.md'
    ]));
    expect(files.map((file) => file.path)).toEqual([
      'docs/my notes.md',
      'src/say "hi".ts',
      'docs/café/résumé.md'
    ]);
  });

  it('marks binary files and zeroes their counts', () => {
    const files = parseNumstatZ(numstatZ(['-\t-\tassets/logo.png']));
    expect(files).toEqual([{ path: 'assets/logo.png', additions: 0, deletions: 0, binary: true }]);
  });

  it('reads a rename as its two trailing path fields', () => {
    // Rename records put the counts first with an EMPTY path, then the old and
    // new paths as their own NUL-separated fields.
    const files = parseNumstatZ(`4\t2\t\0old/name.ts\0new/name.ts\0` + numstatZ(['1\t0\tsrc/c.ts']));
    expect(files).toEqual([
      { path: 'new/name.ts', additions: 4, deletions: 2, binary: false, previousPath: 'old/name.ts' },
      { path: 'src/c.ts', additions: 1, deletions: 0, binary: false }
    ]);
  });

  it('tolerates the leading newline left by the sentinel echo', () => {
    expect(parseNumstatZ(`\n${numstatZ(['1\t1\tsrc/a.ts'])}`)).toEqual([
      { path: 'src/a.ts', additions: 1, deletions: 1, binary: false }
    ]);
  });

  it('returns nothing for an empty diff', () => {
    expect(parseNumstatZ('')).toEqual([]);
    expect(parseNumstatZ('\n')).toEqual([]);
  });
});

describe('planDiffPage', () => {
  it('fits as many files as the budget allows and reports where to resume', () => {
    const files = Array.from({ length: 10 }, (_, i) => stat(`src/f${i}.ts`, 10, 0));
    // ~840 bytes estimated per file; 3000 bytes fits three.
    const page = planDiffPage(files, 0, 3_000, 50);
    expect(page.paths).toEqual(['src/f0.ts', 'src/f1.ts', 'src/f2.ts']);
    expect(page.nextIndex).toBe(3);
  });

  it('resumes exactly where the previous page stopped', () => {
    const files = Array.from({ length: 10 }, (_, i) => stat(`src/f${i}.ts`, 10, 0));
    const first = planDiffPage(files, 0, 3_000, 50);
    const second = planDiffPage(files, first.nextIndex ?? 0, 3_000, 50);
    expect(second.fromIndex).toBe(3);
    expect(second.paths).toEqual(['src/f3.ts', 'src/f4.ts', 'src/f5.ts']);
  });

  it('always includes one file even when it alone blows the whole budget', () => {
    // The regression this guards: selecting zero files leaves nextIndex equal
    // to the cursor, so a caller following nextCursor pages forever without
    // ever advancing. One huge generated file is enough to trigger it.
    const files = [stat('dist/bundle.js', 500_000, 0), stat('src/a.ts', 1, 1)];
    const page = planDiffPage(files, 0, 64_000, 50);
    expect(page.paths).toEqual(['dist/bundle.js']);
    expect(page.nextIndex).toBe(1);
  });

  it('terminates for a whole list of oversized files', () => {
    const files = Array.from({ length: 5 }, (_, i) => stat(`big/f${i}.js`, 200_000, 0));
    const seen: string[] = [];
    let cursor: number | null = 0;
    let guard = 0;
    while (cursor !== null && guard < 20) {
      const page: ReturnType<typeof planDiffPage> = planDiffPage(files, cursor, 8_000, 50);
      seen.push(...page.paths);
      cursor = page.nextIndex;
      guard += 1;
    }
    expect(seen).toEqual(files.map((file) => file.path));
    expect(guard).toBe(5);
  });

  it('caps a page by file count even when every file is tiny', () => {
    const files = Array.from({ length: 100 }, (_, i) => stat(`src/f${i}.ts`, 1, 0));
    const page = planDiffPage(files, 0, 10_000_000, 20);
    expect(page.paths).toHaveLength(20);
    expect(page.nextIndex).toBe(20);
  });

  it('carries a rename\'s old path in the pathspec so git still renders it as a rename', () => {
    const files: DiffFileStat[] = [{ path: 'new.ts', additions: 1, deletions: 1, binary: false, previousPath: 'old.ts' }];
    const page = planDiffPage(files, 0, 64_000, 50);
    expect(page.paths).toEqual(['new.ts']);
    expect(page.pathspecs).toEqual(['new.ts', 'old.ts']);
  });

  it('ends cleanly on an empty or exhausted list', () => {
    expect(planDiffPage([], 0, 64_000, 50)).toMatchObject({ paths: [], nextIndex: null });
    expect(planDiffPage([stat('a.ts')], 1, 64_000, 50)).toMatchObject({ paths: [], nextIndex: null });
  });

  it('clamps a cursor past the end instead of throwing', () => {
    expect(planDiffPage([stat('a.ts')], 999, 64_000, 50)).toMatchObject({ fromIndex: 1, nextIndex: null });
    expect(planDiffPage([stat('a.ts')], -5, 64_000, 50)).toMatchObject({ fromIndex: 0, paths: ['a.ts'] });
  });

  it('walks every file across pages without gaps or repeats', () => {
    const files = Array.from({ length: 37 }, (_, i) => stat(`src/f${i}.ts`, i * 3, i));
    const seen: string[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page: ReturnType<typeof planDiffPage> = planDiffPage(files, cursor, 5_000, 50);
      seen.push(...page.paths);
      cursor = page.nextIndex;
    }
    expect(seen).toEqual(files.map((file) => file.path));
    expect(new Set(seen).size).toBe(files.length);
  });
});

// The parser's contract is with real git, not with the manpage. These run
// against an actual repository so a change in git's -z record layout fails
// here rather than silently mis-listing files in production.
describe('parseNumstatZ against real git', () => {
  // Each case spawns git a dozen times. The work is trivial, but process spawns
  // on a loaded CI runner are not, and the default per-test timeout is tight
  // enough to make these flake rather than fail honestly.
  const GIT_TEST_TIMEOUT_MS = 30_000;

  function gitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'forge-numstat-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'buffer' });
    git('init', '-q', '.');
    git('config', 'user.email', 'test@forge.local');
    git('config', 'user.name', 'Forge Test');
    writeFileSync(join(dir, 'normal.txt'), 'a\nb\nc\n');
    writeFileSync(join(dir, 'my notes.md'), 'x\n');
    writeFileSync(join(dir, 'café.md'), 'x\n');
    writeFileSync(join(dir, 'old-name.ts'), 'q\n');
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    git('add', '-A');
    git('commit', '-qm', 'init');
    appendFileSync(join(dir, 'normal.txt'), 'd\ne\n');
    appendFileSync(join(dir, 'my notes.md'), 'y\nz\n');
    appendFileSync(join(dir, 'café.md'), 'y\n');
    git('mv', 'old-name.ts', 'new-name.ts');
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));
    git('add', '-A');
    return dir;
  }

  it('reads binaries, spaced/non-ASCII paths and renames out of real output', () => {
    const dir = gitRepo();
    try {
      const raw = execFileSync('git', ['-C', dir, 'diff', '--cached', '--numstat', '-z'], { encoding: 'utf8' });
      const files = parseNumstatZ(raw);
      const byPath = new Map(files.map((file) => [file.path, file]));

      expect(byPath.get('logo.png')).toMatchObject({ binary: true, additions: 0, deletions: 0 });
      expect(byPath.get('my notes.md')).toMatchObject({ binary: false, additions: 2 });
      expect(byPath.get('café.md')).toMatchObject({ binary: false, additions: 1 });
      expect(byPath.get('normal.txt')).toMatchObject({ binary: false, additions: 2 });
      // The rename must resolve to the NEW path and remember the old one.
      expect(byPath.get('new-name.ts')).toMatchObject({ previousPath: 'old-name.ts' });
      expect(byPath.has('')).toBe(false);
      expect(files).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);

  it('fetches exactly the planned page, and a rename still renders as a rename', () => {
    const dir = gitRepo();
    try {
      const raw = execFileSync('git', ['-C', dir, 'diff', '--cached', '--numstat', '-z'], { encoding: 'utf8' });
      const plan = planDiffPage(parseNumstatZ(raw), 0, 64_000, 50);
      const diff = execFileSync(
        'git',
        ['-C', dir, '-c', 'core.quotePath=false', '--literal-pathspecs', 'diff', '--cached', '--no-ext-diff', '--binary', '--', ...plan.pathspecs],
        { encoding: 'utf8' }
      );
      // Every planned path appears VERBATIM in the diff header — that is what
      // core.quotePath=false buys; without it git writes "a/caf\303\251.md"
      // and the header stops matching the path reported in `files`.
      for (const path of plan.paths) expect(diff).toContain(path);
      expect(diff).toMatch(/rename (from|to) /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);

  it('pages a single file at a time when the budget only fits one', () => {
    const dir = gitRepo();
    try {
      const raw = execFileSync('git', ['-C', dir, 'diff', '--cached', '--numstat', '-z'], { encoding: 'utf8' });
      const files = parseNumstatZ(raw);
      const seen: string[] = [];
      let cursor: number | null = 0;
      while (cursor !== null) {
        const page: ReturnType<typeof planDiffPage> = planDiffPage(files, cursor, 2_000, 1);
        const diff = execFileSync(
          'git',
          ['-C', dir, '-c', 'core.quotePath=false', '--literal-pathspecs', 'diff', '--cached', '--no-ext-diff', '--', ...page.pathspecs],
          { encoding: 'utf8' }
        );
        expect(page.paths).toHaveLength(1);
        expect(diff).not.toBe('');
        seen.push(...page.paths);
        cursor = page.nextIndex;
      }
      expect(seen.sort()).toEqual(files.map((file) => file.path).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);
});

describe('estimateFileDiffBytes', () => {
  it('grows with changed lines and gives binaries a flat cost', () => {
    expect(estimateFileDiffBytes(stat('a.ts', 0, 0))).toBeLessThan(estimateFileDiffBytes(stat('a.ts', 100, 0)));
    expect(estimateFileDiffBytes({ path: 'a.png', additions: 0, deletions: 0, binary: true }))
      .toBeGreaterThan(estimateFileDiffBytes(stat('a.ts', 0, 0)));
  });
});

describe('diffPageNote', () => {
  it('tells the caller how to get the next page', () => {
    const note = diffPageNote({ shown: 3, total: 40, hasMore: true, truncated: false });
    expect(note).toContain('3 of 40');
    expect(note).toContain('nextCursor');
  });

  it('says a cut-short page is not reachable by paging', () => {
    const note = diffPageNote({ shown: 1, total: 1, hasMore: false, truncated: true });
    expect(note).toContain('forge_files_read');
    expect(note).toContain('paging will not return');
  });

  it('is quiet when the whole diff fits', () => {
    const note = diffPageNote({ shown: 2, total: 2, hasMore: false, truncated: false });
    expect(note).toContain('all 2 changed files');
    expect(note).not.toContain('nextCursor');
  });

  it('reports no changes', () => {
    expect(diffPageNote({ shown: 0, total: 0, hasMore: false, truncated: false })).toBe('No changes.');
  });
});
