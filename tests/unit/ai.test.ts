import { describe, expect, it } from 'vitest';
import {
  aiEnabled,
  condenseDiff,
  generateCommitMessage,
  summarizeDiffForPr
} from '../../apps/forge-edge-gateway/src/ai';

const DIFF = [
  'diff --git a/apps/web/index.ts b/apps/web/index.ts',
  'index 111..222 100644',
  '--- a/apps/web/index.ts',
  '+++ b/apps/web/index.ts',
  '@@ -1,3 +1,4 @@',
  '+const added = true;',
  'diff --git a/packages/core/util.ts b/packages/core/util.ts',
  '@@ -10,2 +10,3 @@',
  '+export const helper = () => 42;'
].join('\n');

/** Env stub whose AI.run resolves with `response`, or rejects when told to. */
function envWith(behavior: { response?: string; throws?: boolean }) {
  return {
    AI: {
      run: async () => {
        if (behavior.throws) throw new Error('workers-ai down');
        return { response: behavior.response };
      }
    }
  } as never;
}

describe('aiEnabled', () => {
  it('is on when the flag is unset', () => {
    expect(aiEnabled({})).toBe(true);
  });
  it('is off for true/1 (case-insensitive, trimmed)', () => {
    expect(aiEnabled({ FORGE_AI_DISABLED: 'true' })).toBe(false);
    expect(aiEnabled({ FORGE_AI_DISABLED: '1' })).toBe(false);
    expect(aiEnabled({ FORGE_AI_DISABLED: ' TRUE ' })).toBe(false);
  });
  it('stays on for other values', () => {
    expect(aiEnabled({ FORGE_AI_DISABLED: 'false' })).toBe(true);
    expect(aiEnabled({ FORGE_AI_DISABLED: '0' })).toBe(true);
  });
});

describe('condenseDiff', () => {
  it('returns the diff unchanged when under the limit', () => {
    expect(condenseDiff(DIFF, 8000)).toBe(DIFF);
  });
  it('keeps diff --git and @@ headers when truncating', () => {
    const big = DIFF + '\n' + 'x'.repeat(5000);
    const condensed = condenseDiff(big, 200);
    expect(condensed.length).toBeLessThanOrEqual(200);
    expect(condensed).toContain('diff --git a/apps/web/index.ts');
    expect(condensed).toContain('diff --git a/packages/core/util.ts');
    expect(condensed).toContain('@@ -1,3 +1,4 @@');
  });
});

describe('generateCommitMessage', () => {
  it('uses the model output subject line', async () => {
    const message = await generateCommitMessage(
      envWith({ response: 'feat: add helper\n\nMore detail.' }),
      DIFF
    );
    expect(message).toBe('feat: add helper\n\nMore detail.');
  });
  it('enforces the 72-char title limit and strips trailing period', async () => {
    const long = 'feat: ' + 'a'.repeat(100) + '.';
    const message = await generateCommitMessage(envWith({ response: long }), DIFF);
    const subject = message.split('\n')[0];
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith('.')).toBe(false);
  });
  it('falls back deterministically to top dirs when the model throws', async () => {
    const message = await generateCommitMessage(envWith({ throws: true }), DIFF);
    expect(message).toBe('chore: update apps, packages');
  });
  it('falls back without calling Workers AI when the policy is local only', async () => {
    let calls = 0;
    const env = {
      AI: { run: async () => { calls += 1; return { response: 'feat: should not run' }; } },
      FORGE_INFERENCE_POLICY: 'local_only',
    } as never;
    expect(await generateCommitMessage(env, DIFF)).toBe('chore: update apps, packages');
    expect(calls).toBe(0);
  });
});

describe('summarizeDiffForPr', () => {
  it('parses the first line as title and the rest as body', async () => {
    const summary = await summarizeDiffForPr(
      envWith({ response: 'feat: helper util\n\n- adds helper\n- why: reuse' }),
      DIFF,
      { branch: 'forge/x', base: 'main' }
    );
    expect(summary.title).toBe('feat: helper util');
    expect(summary.body).toBe('- adds helper\n- why: reuse');
  });
  it('falls back deterministically when the model throws', async () => {
    const summary = await summarizeDiffForPr(envWith({ throws: true }), DIFF, {
      branch: 'forge/x',
      base: 'main'
    });
    expect(summary.title).toBe('forge: update apps, packages');
    expect(summary.body).toContain('- apps/web/index.ts');
    expect(summary.body).toContain('- packages/core/util.ts');
  });
});
