/**
 * Turn a command's output into the answer the agent was actually after.
 *
 * A test run emits hundreds of kilobytes and the agent needs one line of it:
 * did it pass, and if not, which tests failed. Returning the log costs tens of
 * thousands of tokens, and — because output is bounded — usually drops the
 * summary at the end, so the agent pays enormously and still cannot tell.
 *
 * Summarising is not compression for its own sake. It is the difference
 * between a session that can run tests, read failures, fix and re-run, and one
 * that exhausts its context on the first run. The raw log is still kept as an
 * artifact; this only changes what is put in front of the model.
 */

export interface CommandSummary {
  kind: 'tests' | 'typecheck' | 'lint';
  ok: boolean;
  /** One line safe to echo verbatim. */
  headline: string;
  passed?: number;
  failed?: number;
  skipped?: number;
  files?: { passed?: number; failed?: number };
  /** Only the failures — the part worth spending context on. */
  failures?: string[];
}

const MAX_FAILURES = 25;

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** Vitest and Jest share this summary shape closely enough to parse together. */
function summariseTests(output: string): CommandSummary | undefined {
  // "Tests  1 failed | 525 passed | 1 skipped (527)" / "Tests: 3 failed, 5 passed, 8 total"
  const line = /^\s*Tests[: ]\s+(.+)$/mu.exec(output);
  if (!line) return undefined;
  const body = line[1] as string;
  const count = (label: string): number | undefined => {
    const match = new RegExp(`(\\d+)\\s+${label}`, 'u').exec(body);
    return match ? Number(match[1]) : undefined;
  };
  const failed = count('failed') ?? 0;
  const passed = count('passed');
  const skipped = count('skipped');

  const failures = dedupe([
    ...[...output.matchAll(/^\s*(?:FAIL|✕|×)\s+(.+)$/gmu)].map((match) => match[1] as string),
    ...[...output.matchAll(/^\s*●\s+(.+)$/gmu)].map((match) => match[1] as string)
  ]).slice(0, MAX_FAILURES);

  const fileLine = /^\s*Test Files[: ]\s+(.+)$/mu.exec(output);
  const files = fileLine
    ? {
        failed: Number(/(\d+)\s+failed/u.exec(fileLine[1] as string)?.[1] ?? 0),
        passed: Number(/(\d+)\s+passed/u.exec(fileLine[1] as string)?.[1] ?? 0)
      }
    : undefined;

  return {
    kind: 'tests',
    ok: failed === 0,
    headline: failed === 0
      ? `All tests passed (${passed ?? 0} passed${skipped ? `, ${skipped} skipped` : ''}).`
      : `${failed} test${failed === 1 ? '' : 's'} failed, ${passed ?? 0} passed.`,
    ...(passed === undefined ? {} : { passed }),
    failed,
    ...(skipped === undefined ? {} : { skipped }),
    ...(files ? { files } : {}),
    ...(failures.length ? { failures } : {})
  };
}

function summariseTypecheck(output: string): CommandSummary | undefined {
  const errors = dedupe(
    [...output.matchAll(/^(.*?\(\d+,\d+\): error TS\d+: .*)$/gmu)].map((match) => match[1] as string)
  );
  if (!errors.length) return undefined;
  return {
    kind: 'typecheck',
    ok: false,
    headline: `${errors.length} TypeScript error${errors.length === 1 ? '' : 's'}.`,
    failed: errors.length,
    failures: errors.slice(0, MAX_FAILURES)
  };
}

/**
 * Summarise when the command is one whose output has a known shape and the
 * run produced enough of it to be worth replacing. Returns undefined for
 * anything unrecognised, so an unknown command always keeps its raw output.
 */
export function summariseCommandOutput(input: {
  command: string;
  output: string;
  exitCode?: number;
}): CommandSummary | undefined {
  const { command, output } = input;
  if (!output.trim()) return undefined;
  // The runner's own name is enough ("vitest run"); a package-manager script
  // needs the word test ("pnpm test") to avoid claiming every pnpm command.
  const looksLikeTests = /\b(vitest|jest|mocha|playwright)\b/u.test(command)
    || /\b(pnpm|npm|yarn|bun|make)\b[^&|;]*\btests?\b/u.test(command);
  const looksLikeTypecheck = /\btsc\b|\btypecheck\b/u.test(command);

  if (looksLikeTests) {
    const tests = summariseTests(output);
    if (tests) return tests;
  }
  if (looksLikeTypecheck || looksLikeTests) {
    const typecheck = summariseTypecheck(output);
    if (typecheck) return typecheck;
  }
  return undefined;
}
