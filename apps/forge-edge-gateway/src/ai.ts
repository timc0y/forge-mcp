// Best-effort Cloudflare Workers AI helpers for commit messages and PR
// summaries. Every entry point wraps the model call in try/catch and falls
// back to deterministic text derived from the diff, so AI is never on the
// critical path — a model outage or a disabled binding just yields a plainer
// (but always valid) message. Cost note: each model call runs the small
// llama-3.1-8b-instruct-fast model, roughly ~50-200 neurons per invocation.

import type { Env } from './env';
import { assertForgeWorkersAiAllowed } from '@forge/insight';

const MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const MAX_DIFF_CHARS = 8000;
const MAX_TITLE_CHARS = 72;

/** AI is ON unless FORGE_AI_DISABLED is explicitly 'true'/'1'. */
export function aiEnabled(env: Pick<Env, 'FORGE_AI_DISABLED'>): boolean {
  const flag = env.FORGE_AI_DISABLED?.trim().toLowerCase();
  return flag !== 'true' && flag !== '1';
}

/**
 * Condense a diff to at most `maxChars`, preferring the structurally useful
 * lines — `diff --git` file headers and `@@` hunk headers — plus a bounded
 * slice of the remaining body so the model still sees real content.
 */
export function condenseDiff(diff: string, maxChars = MAX_DIFF_CHARS): string {
  if (diff.length <= maxChars) return diff;
  const lines = diff.split('\n');
  const headers: string[] = [];
  const body: string[] = [];
  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('@@')) headers.push(line);
    else body.push(line);
  }
  const headerText = headers.join('\n');
  if (headerText.length >= maxChars) return headerText.slice(0, maxChars);
  const remaining = maxChars - headerText.length - 1;
  const bodyText = body.join('\n').slice(0, Math.max(0, remaining));
  return headerText + (bodyText ? '\n' + bodyText : '');
}

/** Extract the file paths from `diff --git a/<path> b/<path>` header lines. */
function diffPaths(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split('\n')) {
    const match = /^diff --git a\/(.+?) b\//.exec(line);
    if (match?.[1]) paths.push(match[1]);
  }
  return paths;
}

/** Distinct top-level directories (or bare filenames) touched by the diff. */
function topLevelDirs(diff: string): string[] {
  const dirs = new Set<string>();
  for (const path of diffPaths(diff)) {
    const slash = path.indexOf('/');
    dirs.add(slash === -1 ? path : path.slice(0, slash));
  }
  return [...dirs];
}

function enforceTitle(title: string): string {
  let value = title.trim().replace(/\.$/, '');
  if (value.length > MAX_TITLE_CHARS) value = value.slice(0, MAX_TITLE_CHARS).trimEnd();
  return value;
}

function firstString(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    if (typeof record.response === 'string') return record.response;
  }
  return '';
}

interface PrSummary {
  title: string;
  body: string;
}

/**
 * Summarise a branch diff into a terse conventional-commit-style PR title and a
 * short markdown body. Never throws — on any failure returns a deterministic
 * fallback derived from the changed paths.
 */
export async function summarizeDiffForPr(
  env: Pick<Env, 'AI' | 'FORGE_INFERENCE_POLICY' | 'FORGE_APPROVED_CLOUD_PROVIDERS'>,
  diff: string,
  ctx: { branch: string; base: string; tenantId?: string; projectId?: string }
): Promise<PrSummary> {
  const dirs = topLevelDirs(diff);
  const fallback: PrSummary = {
    title: enforceTitle(`forge: update ${dirs.join(', ') || 'workspace'}`),
    body: prFallbackBody(diff)
  };
  try {
    assertForgeWorkersAiAllowed({
      env,
      tenantId: ctx.tenantId ?? 'system',
      projectId: ctx.projectId ?? 'commit-summary',
      purpose: 'forge.commit-summary',
      classification: 'private',
    });
    const condensed = condenseDiff(diff);
    const output = await env.AI.run(MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'You write pull request descriptions. Reply with the title on the first line, then a blank line, then a short markdown body. The title must be a terse conventional-commit style summary under 72 characters with no trailing period. The body uses bullet points describing what changed and why.'
        },
        {
          role: 'user',
          content: `Branch ${ctx.branch} onto ${ctx.base}. Summarise this diff:\n\n${condensed}`
        }
      ]
    });
    const raw = firstString(output).trim();
    if (!raw) return fallback;
    const [firstLine = '', ...rest] = raw.split('\n');
    const title = enforceTitle(firstLine);
    const body = rest.join('\n').trim();
    return {
      title: title || fallback.title,
      body: body || fallback.body
    };
  } catch {
    return fallback;
  }
}

function prFallbackBody(diff: string): string {
  const paths = diffPaths(diff);
  if (!paths.length) return 'Updates the workspace.';
  return ['Changed files:', ...paths.map((path) => `- ${path}`)].join('\n');
}

/**
 * Generate a one-line conventional-commit subject (plus optional short body)
 * from a diff. Never throws — falls back to `chore: update <top dirs>`.
 */
export async function generateCommitMessage(
  env: Pick<Env, 'AI' | 'FORGE_INFERENCE_POLICY' | 'FORGE_APPROVED_CLOUD_PROVIDERS'>,
  diff: string,
  workspace: { tenantId?: string; projectId?: string } = {},
): Promise<string> {
  const dirs = topLevelDirs(diff);
  const fallback = `chore: update ${dirs.join(', ') || 'workspace'}`;
  try {
    assertForgeWorkersAiAllowed({
      env,
      tenantId: workspace.tenantId ?? 'system',
      projectId: workspace.projectId ?? 'commit-message',
      purpose: 'forge.commit-message',
      classification: 'private',
    });
    const condensed = condenseDiff(diff);
    const output = await env.AI.run(MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'You write git commit messages. Reply with a single conventional-commit subject line under 72 characters with no trailing period. Optionally add a blank line and a short body. Output only the commit message.'
        },
        { role: 'user', content: `Write a commit message for this diff:\n\n${condensed}` }
      ]
    });
    const raw = firstString(output).trim();
    if (!raw) return fallback;
    const [firstLine = '', ...rest] = raw.split('\n');
    const subject = enforceTitle(firstLine);
    const body = rest.join('\n').trim();
    return body ? `${subject}\n\n${body}` : subject || fallback;
  } catch {
    return fallback;
  }
}
