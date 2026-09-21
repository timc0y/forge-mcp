import type { ToolContext, ToolOutcome } from './tool-types';
import { ForgeError } from './errors';
import { RequestBudget, utf8Bytes } from './evidence';
import { choice, evaluate } from './semantics';
import { githubFailure, object } from './snapshot';

export type PublicSearchKind = 'repositories' | 'code';
/** Bare project names mean repository discovery. Explicit code searches have a fixed prefix. */
export async function discoverPublic(ctx: ToolContext, query: string): Promise<ToolOutcome> {
  const input = query.trim();
  if (!input || utf8Bytes(input) > 1500) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Public GitHub discovery needs a bounded public project or code query.' });
  let kind: PublicSearchKind;
  let terms = input;
  const explicit = /^(repos?|repositories|code):\s*(.+)$/is.exec(input);
  if (explicit) { kind = explicit[1]!.toLowerCase() === 'code' ? 'code' : 'repositories'; terms = explicit[2]!; }
  else if (/^[\w.-]+(?:\/[\w.-]+)?$/.test(input)) kind = 'repositories';
  else {
    const result = await evaluate(ctx.env, { publicUserRequest: input }, {
      intent: { type: 'choice', instructions: 'Does this explicit public GitHub request seek a project/library repository or code occurrences? Bare project names belong to repository discovery.', criteria: { repositories: 'Find public projects or libraries', code: 'Find code occurrences or examples across public projects' } }
    }, 'forge-public-intent/v1', new RequestBudget());
    const intent = choice(result, 'intent');
    if (intent.confidence < 0.7) throw new ForgeError({ code: 'FORGE_AMBIGUOUS', message: 'Public search intent is uncertain. Use repos:project or code:public expression; no other search was attempted.' });
    kind = intent.choice as PublicSearchKind;
  }
  if (/\bis:(?:private|internal)\b/i.test(terms)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Global discovery is public-only. Private repository searches must name the authorized repository.' });
  let shaped: string;
  let allowedCodeRepos: Set<string> | null = null;
  if (kind === 'code') {
    const repositories = [...terms.matchAll(/(?:^|\s)repo:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=\s|$)/g)].map((match) => match[1]!);
    const unique = [...new Set(repositories.map((repo) => repo.toLowerCase()))];
    allowedCodeRepos = new Set(unique);
    if (!unique.length) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Public global code search requires an explicit repo:owner/name scope. GitHub code search has no public-visibility qualifier, so Forge will not run an authenticated unscoped search that could inspect private repositories.' });
    if (unique.length > 5) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Public code discovery accepts at most five explicit repository scopes per request.' });
    for (const named of unique) {
      const metadata = await ctx.ghUser(`/repos/${named}`);
      if (metadata.status !== 200) githubFailure(metadata.status, `public repository scope ${named}`);
      const privateRepo = object(metadata.json)?.private;
      if (privateRepo !== false) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: `Code discovery refused ${named}: Forge could not establish that every named repository is public. No code search was attempted.` });
    }
    shaped = terms.replace(/\bis:public\b/gi, '').trim();
  } else {
    shaped = `${terms.replace(/\bis:public\b/gi, '').trim()} is:public`;
  }
  const response = await ctx.ghUser(`/search/${kind}?q=${encodeURIComponent(shaped)}&per_page=10`, { accept: kind === 'code' ? 'application/vnd.github.text-match+json' : 'application/vnd.github+json', maxBytes: 256 * 1024 });
  if (response.status !== 200) githubFailure(response.status, 'public GitHub discovery');
  const body = object(response.json);
  if (!Array.isArray(body?.items) || !Number.isSafeInteger(body.total_count) || (body.total_count as number) < 0 || typeof body.incomplete_results !== 'boolean') githubFailure(502, 'public search evidence');
  const matches = body.items.map((raw) => {
    const item = object(raw);
    const repository = kind === 'repositories' ? item : object(item?.repository);
    if (typeof repository?.full_name !== 'string' || typeof item?.html_url !== 'string' || repository.private !== false) githubFailure(502, 'a verified public search match');
    if (kind === 'code' && (!allowedCodeRepos || !allowedCodeRepos.has(repository.full_name.toLowerCase()))) githubFailure(502, 'a code-search result inside the verified public repository scopes');
    const url = new URL(item.html_url);
    if (url.origin !== 'https://github.com') githubFailure(502, 'a canonical GitHub source address');
    const fragments = Array.isArray(item.text_matches) ? item.text_matches.map((match) => object(match)?.fragment).filter((value): value is string => typeof value === 'string') : [];
    return {
      repo: repository.full_name,
      ...(kind === 'code' && typeof item.path === 'string' ? { path: item.path } : {}),
      url: item.html_url,
      text: kind === 'repositories' ? (typeof item.description === 'string' ? item.description.slice(0, 500) : '') : fragments.slice(0, 2).join('\n').slice(0, 800),
      evidence: 'GitHub indexed discovery; not a source read at an inspected commit'
    };
  });
  if (kind === 'repositories') matches.sort((a, b) => Number(b.repo.toLowerCase() === terms.toLowerCase() || b.repo.split('/')[1]?.toLowerCase() === terms.toLowerCase()) - Number(a.repo.toLowerCase() === terms.toLowerCase() || a.repo.split('/')[1]?.toLowerCase() === terms.toLowerCase()));
  return {
    summary: `${matches.length} public ${kind} matches returned by GitHub.`,
    structured: { kind, matches, coverage: body.incomplete_results || body.total_count > matches.length ? 'bounded' : 'complete', limits: ['This is discovery from GitHub’s index. An empty result is not proof that source does not exist. No private repository context was attached.'], next: 'Pass a returned GitHub URL directly to forge_read for immutable source evidence.' }
  };
}
