#!/usr/bin/env node
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';

const defaultDataset = new URL('./context-questions.json', import.meta.url);
const help = `Context evaluation (no network by default)
  node worker/scripts/evaluate-context.mjs --mock
  node worker/scripts/evaluate-context.mjs --check-dataset
  node worker/scripts/evaluate-context.mjs --real --url <MCP URL> --at <commit SHA> [--case <id>] [--follow-ups 0..3] [--output <file>]
  --dataset <file> selects a bounded question set in real or schema-check mode (maximum six cases); --mock rejects overrides.
The dataset-only command checks schema. --mock also checks every dataset selector and assertion against local source.
Real mode calls only forge_read on the explicitly configured runtime, which owns GitHub authorization, JEV and shared admission. It can consume paid JEV quota. Set FORGE_CONTEXT_EVAL_URL instead of --url if preferred. A runtime bearer credential may be supplied privately in FORGE_CONTEXT_EVAL_TOKEN; it is never printed. Exact follow-ups use returned selectors, never gold selectors. Fragment containment requires original-file parser anchors; missing anchors remain unverified. Mock mode proves plumbing only.`;

export function validateDataset(dataset) {
  if (!Array.isArray(dataset) || dataset.length < 1 || dataset.length > 6) throw new Error('Use 1–6 real questions.');
  const ids = new Set();
  for (const entry of dataset) {
    if (!entry || !/^[a-z0-9-]+$/.test(entry.id) || ids.has(entry.id) || !/^[^/\s]+\/[^/\s]+$/.test(entry.repo) || typeof entry.question !== 'string' || !entry.question.trim() || Buffer.byteLength(entry.question) > 2000) throw new Error('Invalid or duplicate question.');
    ids.add(entry.id);
    if (!Array.isArray(entry.required) || !entry.required.length || entry.required.length > 12 || !Array.isArray(entry.counterevidence) || entry.counterevidence.length > 12) throw new Error('Each question needs bounded required and counterevidence criteria.');
    for (const criterion of [...entry.required, ...entry.counterevidence]) {
      if (typeof criterion.selector !== 'string' || !criterion.selector || !Array.isArray(criterion.mustContain) || !criterion.mustContain.length || !criterion.mustContain.every((text) => typeof text === 'string' && text.length)) throw new Error('Expected evidence must name an exact selector and source assertions.');
    }
  }
  return dataset;
}
function unpack(result) {
  if (result.isError) {
    const code = result.content?.find((item) => item.type === 'text')?.text.match(/^FORGE_[A-Z_]+/)?.[0];
    return { error: code ?? 'RUNTIME_TOOL_ERROR' };
  }
  if (result.structuredContent) return result.structuredContent;
  for (const item of result.content ?? []) if (item.type === 'text') {
    try { const value = JSON.parse(item.text); if (value && typeof value === 'object') return value; } catch { /* The first text item is a human summary. */ }
  }
  return { error: 'MISSING_STRUCTURED_EVIDENCE' };
}
let selectorsRuntime;
async function sourceSelectors() {
  if (!selectorsRuntime) selectorsRuntime = (async () => {
    const { build } = await import('esbuild');
    const cache = new URL('../node_modules/.cache/', import.meta.url);
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(fileURLToPath(new URL('context-evaluation-', cache)));
    try {
      const outfile = `${directory}/selectors.cjs`;
      await build({ entryPoints: [fileURLToPath(new URL('../src/selectors.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
      return createRequire(import.meta.url)(outfile);
    } finally { await rm(directory, { recursive: true, force: true }); }
  })();
  return selectorsRuntime;
}
function withoutComments(text, path) {
  const json = /\.jsonc?$/i.test(path);
  if (!json && !/\.[cm]?[jt]sx?$/i.test(path)) return text;
  const kind = /\.tsx$/i.test(path) ? ts.ScriptKind.TSX : /\.jsx$/i.test(path) ? ts.ScriptKind.JSX : /\.[cm]?js$/i.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = json ? ts.parseJsonText(path, text) : ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const comments = new Map();
  const jsxText = [];
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push({ pos: node.pos, end: node.end });
    // Parser token boundaries distinguish regex literals from comment-like text inside them.
    for (const range of [...ts.getLeadingCommentRanges(text, node.pos) ?? [], ...ts.getTrailingCommentRanges(text, node.end) ?? []]) comments.set(`${range.pos}:${range.end}`, range);
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);
  // Comment-range helpers can start inside JSX literal text, where slashes are content.
  for (const { pos, end } of [...comments.values()].filter((range) => !jsxText.some((literal) => range.pos >= literal.pos && range.pos < literal.end)).sort((a, b) => b.pos - a.pos)) text = text.slice(0, pos) + text.slice(pos, end).replace(/[^\r\n]/g, ' ') + text.slice(end);
  return text;
}
function completeBodyRange(item, parser, path) {
  const range = item.range;
  if (!range || ![range.start, range.end, range.startLine, range.endLine].every(Number.isSafeInteger) || range.start < 0 || range.end - range.start !== item.text.length || range.startLine < 1) return null;
  const local = parser.selectSource({ path }, item.text).range;
  return range.endLine - range.startLine + 1 === local.endLine ? range : null;
}
function selectedSource(selector, evidence, parser, source, anchors) {
  if (!parser || !source) return null;
  let target;
  try { target = parser.parseSelector(selector); } catch { return null; }
  for (const item of evidence) {
    if (item.representation !== 'body' || item.coverage !== 'complete' || typeof item.text !== 'string') continue;
    if (item.source && (item.source.sha !== source.sha || item.source.repo?.toLowerCase() !== source.repo?.toLowerCase())) continue;
    try {
      const container = parser.parseSelector(item.selector);
      if (container.path !== target.path) continue;
      const range = completeBodyRange(item, parser, container.path);
      if (!range) continue;
      if (container.lines && (range.startLine !== container.lines[0] || range.endLine !== container.lines[1])) continue;
      const prefix = range.start === 0 && range.startLine === 1;
      const wholeFile = !container.selection && prefix && !item.next && (container.lines ? Number.isInteger(item.totalLines) && range.endLine === item.totalLines : item.totalLines === undefined || range.endLine === item.totalLines);
      if (wholeFile) {
        const selected = parser.selectSource(target, item.text);
        return withoutComments(item.text, target.path).slice(selected.range.start, selected.range.end);
      }
      // An exact receipt retains its original parser identity, including scope and duplicate indexes.
      if (container.selection && target.selection?.kind === container.selection.kind && target.selection.value === container.selection.value) return withoutComments(item.text, target.path);
      if (target.lines) {
        // Symbol ranges can begin or end inside a physical line; only line receipts prove its boundaries.
        if (!container.lines || !prefix || target.lines[0] < range.startLine || target.lines[1] > range.endLine) continue;
        const requested = { ...target, lines: target.lines.map((line) => line - range.startLine + 1) };
        const selected = parser.selectSource(requested, item.text);
        return withoutComments(item.text, target.path).slice(selected.range.start, selected.range.end);
      }
      if (!target.selection) continue;
      // A fragment cannot establish global names or uniqueness. Use original-file parser anchors only.
      const matching = anchors.filter((anchor) => anchor.selector === selector);
      if (matching.length !== 1) continue;
      const child = matching[0].range;
      if (!child || ![child.start, child.end, child.startLine, child.endLine].every(Number.isSafeInteger) || child.start < range.start || child.end > range.end || child.end <= child.start) continue;
      const start = child.start - range.start;
      const end = child.end - range.start;
      const startLine = range.startLine + item.text.slice(0, start).split('\n').length - 1;
      const endLine = range.startLine + item.text.slice(0, end - 1).split('\n').length - 1;
      if (child.startLine !== startLine || child.endLine !== endLine) continue;
      // An original child anchor proves a complete declaration even when surrounding line context is unknown.
      return container.selection || prefix ? withoutComments(item.text, target.path).slice(start, end) : withoutComments(item.text.slice(start, end), target.path);
    } catch { /* Invalid ranges, ambiguous whole-file selections and incomplete receipts prove nothing. */ }
  }
  return null;
}
function observed(criterion, evidence, parser, source, anchors) {
  // Assertions belong to the original requested child, never a sibling or a comment.
  return evidence.some((item) => {
    const selected = selectedSource(criterion.selector, [item], parser, source, anchors);
    return selected !== null && criterion.mustContain.every((text) => selected.includes(text));
  });
}
function usageOf(packet) {
  const stages = packet?.inference ?? [];
  const known = stages.filter((stage) => stage.usage);
  return { inputTokens: known.reduce((sum, stage) => sum + stage.usage.inputTokens, 0), outputTokens: known.reduce((sum, stage) => sum + stage.usage.outputTokens, 0), stagesReported: known.length, stagesUnreported: stages.length - known.length, accountingSettledStages: stages.filter((stage) => stage.accounting === 'settled').length, accountingUnknownStages: stages.filter((stage) => stage.accounting !== 'settled').length };
}
export async function judgeQuestion(entry, packet, evidence = packet?.evidence ?? []) {
  let parser;
  try { parser = await sourceSelectors(); } catch { /* A failed parser stage remains explicit below. */ }
  const source = packet?.source;
  const anchors = packet?.selectionAnchors ?? [];
  const matches = (criterion) => observed(criterion, evidence, parser, source, anchors);
  const delivered = (selector) => selectedSource(selector, evidence, parser, source, anchors) !== null;
  const missing = entry.required.filter((criterion) => !matches(criterion)).map((criterion) => criterion.selector);
  const missingCounterevidence = entry.counterevidence.filter((criterion) => !matches(criterion)).map((criterion) => criterion.selector);
  const requiredEvidenceRecall = (entry.required.length - missing.length) / entry.required.length;
  const remainingDelivery = (packet?.required ?? []).filter((item) => !delivered(item.selector)).map((item) => item.selector);
  const recovered = new Set((packet?.required ?? []).filter((item) => !item.delivered && delivered(item.selector)).map((item) => item.selector));
  const gap = packet?.gap;
  const recoveredGap = gap?.category !== 'incomplete' && gap?.selector && recovered.has(gap.selector);
  const compilerUnverified = (packet?.unverified ?? []).filter((message) => {
    if (message.startsWith('Required source not delivered: ') && recovered.has(message.slice('Required source not delivered: '.length))) return false;
    if (recoveredGap && message === `The identified ${gap.category} gap remains unverified.`) return false;
    return true;
  });
  const unresolvedSemanticGap = gap?.category === 'incomplete' || !!(gap?.category && gap.category !== 'none' && !gap.addressed && !recoveredGap);
  const failedStages = packet?.failedStages ?? [];
  const metadataComplete = packet?.requiredCoverage?.complete !== false && packet?.unverifiedCoverage?.complete !== false && !packet?.metadataBounded;
  const deliveryRecovered = packet?.status === 'insufficient' && recovered.size > 0 && !remainingDelivery.length && metadataComplete;
  return {
    requiredEvidenceRecall, missing, missingCounterevidence,
    counterevidence: entry.counterevidence.map((criterion) => ({ selector: criterion.selector, delivered: matches(criterion) })),
    compilerUnverified, remainingDelivery, unresolvedSemanticGap, failedStages, recoveredSelectors: [...recovered], parserProof: parser ? 'available' : 'PARSER_PROOF_UNAVAILABLE',
    taskCompletion: {
      judgment: parser && (packet?.status === 'bounded' || deliveryRecovered) && !missing.length && !missingCounterevidence.length && !compilerUnverified.length && !remainingDelivery.length && !unresolvedSemanticGap && !failedStages.length && metadataComplete ? 'evidence-complete' : 'insufficient',
      basis: 'Original parser identities from exact receipts, whole-file parsing or bounded original-file anchors, plus source assertions and remaining compiler obligations. Physical line assertions require known original lexical context; unknown partial-line context remains unverified. Only source-delivery failures satisfied by same-identity reads are reconciled; semantic gaps and failed stages remain unverified. Human answer quality and runtime execution are not established.',
      humanReview: null
    }
  };
}
export async function evaluateQuestions(cases, callRead, { at, followUps = 0, measurement = 'injected-transport' } = {}) {
  const started = performance.now();
  const rows = [];
  let calls = 0;
  let knownGitHubCalls = 0;
  let githubUnreportedReads = 0;
  let semanticStages = 0;
  let semanticUnreportedReads = 0;
  const cumulativeUsage = { inputTokens: 0, outputTokens: 0, stagesReported: 0, stagesUnreported: 0, accountingSettledStages: 0, accountingUnknownStages: 0 };
  const read = async (arguments_) => {
    calls++;
    try { return unpack(await callRead(arguments_)); } catch { return { error: 'RUNTIME_TRANSPORT_ERROR' }; }
  };
  for (const entry of cases) {
    const questionStarted = performance.now();
    const arguments_ = { repo: entry.repo, at, query: entry.question };
    const roundStarted = performance.now();
    const response = await read(arguments_);
    const packet = response.context;
    const matchesSource = (source) => source?.sha === at && typeof source.repo === 'string' && source.repo.toLowerCase() === entry.repo.toLowerCase();
    const sourceError = packet && !matchesSource(packet.source) ? 'SOURCE_IDENTITY_MISMATCH' : null;
    const judgedPacket = sourceError ? { status: 'unavailable', evidence: [], unverified: ['Returned source identity does not match the requested repository and commit.'] } : packet;
    const rounds = [{ kind: 'context', latencyMs: performance.now() - roundStarted, error: sourceError ?? response.error ?? null }];
    const evidence = [...(judgedPacket?.evidence ?? [])];
    if (Number.isInteger(packet?.budget?.githubCalls)) knownGitHubCalls += packet.budget.githubCalls; else githubUnreportedReads++;
    if (Number.isInteger(packet?.budget?.jevStages)) semanticStages += packet.budget.jevStages; else semanticUnreportedReads++;
    const usage = usageOf(packet);
    for (const key of Object.keys(cumulativeUsage)) cumulativeUsage[key] += usage[key];
    const initial = await judgeQuestion(entry, judgedPacket);
    const returnedSelectors = [...new Set([
      ...(packet?.required ?? []).filter((item) => !item.delivered).map((item) => packet.omitted?.find((omitted) => omitted.selector === item.selector)?.followUp ?? item.selector),
      ...(packet?.omitted ?? []).map((item) => item.followUp ?? item.selector),
      ...(packet?.recoverySelectors ?? [])
    ])];
    const pinned = sourceError ? undefined : packet?.source?.sha;
    const followed = [];
    if (/^[0-9a-f]{40}$/.test(pinned ?? '')) for (const selector of returnedSelectors.slice(0, followUps)) {
      const followStarted = performance.now();
      const next = await read({ repo: entry.repo, at: pinned, paths: [selector] });
      // The public exact-read receipt does not expose GitHub request counts.
      githubUnreportedReads++;
      followed.push(selector);
      const followError = !next.error && !matchesSource(next.source) ? 'SOURCE_IDENTITY_MISMATCH' : next.error ?? null;
      rounds.push({ kind: 'exact-source', selector, latencyMs: performance.now() - followStarted, error: followError });
      if (!followError) for (const file of next.files ?? []) evidence.push({ ...file, source: next.source, coverage: 'complete', representation: file.representation ?? 'body' });
    }
    rows.push({
      id: entry.id, repo: entry.repo, question: entry.question, requestedSha: at, sourceSha: packet?.source?.sha ?? null,
      status: judgedPacket?.status ?? 'unavailable', error: sourceError ?? response.error ?? null,
      initial, afterReturnedSelectorReads: await judgeQuestion(entry, judgedPacket, evidence),
      deliveredSelectors: evidence.map((item) => item.selector), followUpSelectors: returnedSelectors, followed,
      usage, jevStages: packet?.budget?.jevStages ?? null, githubCalls: packet?.budget?.githubCalls ?? null,
      latencyMs: performance.now() - questionStarted, rounds,
      cumulative: { forgeReadCalls: calls, semanticStagesKnown: semanticStages, semanticUnreportedReads, githubCallsKnown: knownGitHubCalls, githubUnreportedReads, usage: { ...cumulativeUsage }, latencyMs: performance.now() - started }
    });
  }
  return { mode: measurement, measuredAt: new Date().toISOString(), at, judgments: 'Source-only rubric; human answer-quality review remains unfilled. No retrieval-quality claim follows from the mock evaluation.', rows, totals: rows.at(-1)?.cumulative ?? null };
}
async function main() {
  const args = process.argv.slice(2);
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--mock', '--real', '--check-dataset', '--help', '--url', '--at', '--case', '--dataset', '--follow-ups', '--output'].includes(flag) || flags.has(flag)) throw new Error('Invalid or repeated argument.');
    if (['--url', '--at', '--case', '--dataset', '--follow-ups', '--output'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing argument value.');
      flags.set(flag, value);
    } else flags.set(flag, true);
  }
  if (!args.length || flags.has('--help')) { console.log(help); return; }
  if (['--mock', '--real', '--check-dataset'].filter((flag) => flags.has(flag)).length !== 1) throw new Error('Choose exactly one evaluation mode.');
  if (flags.has('--mock') && (flags.has('--dataset') || flags.has('--case'))) { console.error('--mock uses the built-in fixtures; --dataset and --case overrides are unsupported.'); process.exitCode = 1; return; }
  const dataset = validateDataset(JSON.parse(await readFile(flags.get('--dataset') ?? defaultDataset, 'utf8')));
  const cases = flags.has('--case') ? dataset.filter((entry) => entry.id === flags.get('--case')) : dataset;
  if (!cases.length) throw new Error('Unknown dataset case.');
  if (flags.has('--check-dataset')) { console.log(JSON.stringify({ mode: 'dataset-schema-check', sourceAssertionsChecked: false, cases: cases.map((entry) => entry.id), networkCalls: 0 })); return; }
  if (flags.has('--mock')) {
    console.log('Deterministic 30-case plumbing and local-source dataset checks; no live JEV or real-question measurements.');
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', 'tests/context-evaluation.test.ts'], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit' });
    process.exitCode = result.status ?? 1; return;
  }
  const endpoint = flags.get('--url') ?? process.env.FORGE_CONTEXT_EVAL_URL;
  const at = flags.get('--at');
  const followUps = Number(flags.get('--follow-ups') ?? 0);
  if (!endpoint || !/^[0-9a-f]{40}$/.test(at ?? '') || !Number.isInteger(followUps) || followUps < 0 || followUps > 3) throw new Error('Real mode requires an explicit MCP URL, full commit SHA, and 0–3 exact follow-ups. No call was made.');
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS or loopback HTTP with no URL credentials, query or fragment.');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  let transportRequests = 0;
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: process.env.FORGE_CONTEXT_EVAL_TOKEN ? { headers: { authorization: `Bearer ${process.env.FORGE_CONTEXT_EVAL_TOKEN}` } } : {},
    reconnectionOptions: { maxRetries: 0 },
    fetch: async (input, init) => { transportRequests++; return fetch(input, init); }
  });
  const client = new Client({ name: 'forge-context-evaluation', version: '1.0.0' });
  try {
    await client.connect(transport);
    const report = await evaluateQuestions(cases, (arguments_) => client.callTool({ name: 'forge_read', arguments: arguments_ }, undefined, { timeout: 60_000 }), { at, followUps, measurement: 'real-runtime' });
    report.transportRequestsBeforeClose = transportRequests;
    const json = JSON.stringify(report, null, 2) + '\n';
    if (flags.has('--output')) await writeFile(flags.get('--output'), json, { flag: 'wx' });
    else process.stdout.write(json);
    if (report.rows.some((row) => row.afterReturnedSelectorReads.taskCompletion.judgment !== 'evidence-complete')) process.exitCode = 1;
  } finally { await client.close(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => {
  // Transport exceptions can contain credentials or response bodies.
  console.error('Context evaluation failed. Check arguments, runtime authorization and operator diagnostics; no secret or raw transport error was printed.');
  process.exitCode = 1;
});
