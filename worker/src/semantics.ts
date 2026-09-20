import type { Env } from './env';
import { ForgeError } from './errors';
import { RequestBudget, utf8Bytes } from './evidence';
import { object } from './snapshot';
import { assertNoHighSeveritySecretText } from './content-safety';

export type Question =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };
export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };
export interface Evaluation {
  answers: Record<string, Answer>;
  requestedModel: 'typesafe/jev';
  returnedModel: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  contract: 'cloudflare-jev-output-v1';
  template: string;
  modelPinned: false;
}
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
function invalid(message: string): never {
  throw new ForgeError({ code: 'FORGE_UPSTREAM_UNAVAILABLE', message: `JEV semantic evaluation is unavailable: ${message}. No alternative ranking was substituted.` });
}
function distribution(value: unknown, keys: string[]): Record<string, number> {
  const record = object(value);
  if (!record || Object.keys(record).length !== keys.length || !keys.every((key) => probability(record[key]))) invalid('incomplete probability distribution');
  const values = record as Record<string, number>;
  const sum = Object.values(values).reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 0.001) invalid('probabilities do not sum to one');
  return values;
}
export function validateQuestions(questions: Record<string, Question>): void {
  const entries = Object.entries(questions);
  if (!entries.length || entries.length > 96) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'A semantic stage requires 1–96 atomic questions.' });
  for (const [id, question] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(id) || !question.instructions.trim()) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Invalid semantic question identity or instruction.' });
    if (question.type === 'choice' && (Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 255)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Choice requires 2–255 explicit options.' });
    if (question.type === 'score' && (question.criteria.length < 2 || question.criteria.length > 10)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Score requires 2–10 ordered levels.' });
  }
}
/** The documented JEV model output from Cloudflare's universal /ai/run endpoint. No alternate envelope is accepted. */
export function parseEvaluation(raw: unknown, questions: Record<string, Question>, template: string): Evaluation {
  validateQuestions(questions);
  const result = object(raw);
  const answers = object(result?.answers);
  if (!result || typeof result.model !== 'string' || !answers) invalid('the selected JEV response is missing model or answers');
  const parsed: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = object(answers[id]);
    if (!answer || answer.type !== question.type) invalid(`missing or mismatched answer ${id}`);
    if (question.type === 'noul') {
      if (!probability(answer.noul)) invalid(`invalid Noul answer ${id}`);
      parsed[id] = { type: 'noul', noul: answer.noul };
    } else if (question.type === 'choice') {
      if (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice) || !probability(answer.confidence)) invalid(`invalid Choice answer ${id}`);
      const probabilities = distribution(answer.probabilities, Object.keys(question.criteria));
      if (probabilities[answer.choice]! + 0.001 < Math.max(...Object.values(probabilities))) invalid(`Choice ${id} is not a highest-probability option`);
      parsed[id] = { type: 'choice', choice: answer.choice, probabilities, confidence: answer.confidence };
    } else {
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1 || !probability(answer.confidence)) invalid(`invalid Score answer ${id}`);
      const probabilities = distribution(answer.probabilities, question.criteria.map((_value, index) => String(index)));
      const expectation = Object.entries(probabilities).reduce((sum, [level, value]) => sum + Number(level) * value, 0);
      if (Math.abs(expectation - answer.score) > 0.01) invalid(`Score ${id} disagrees with its distribution`);
      parsed[id] = { type: 'score', score: answer.score, probabilities, confidence: answer.confidence };
    }
  }
  const rawUsage = object(result?.usage);
  const input = rawUsage?.input_tokens;
  const output = rawUsage?.output_tokens;
  const usage = Number.isSafeInteger(input) && Number.isSafeInteger(output) && (input as number) >= 0 && (output as number) >= 0 ? { inputTokens: input as number, outputTokens: output as number } : null;
  return { answers: parsed, requestedModel: 'typesafe/jev', returnedModel: result.model as string, usage, template, contract: 'cloudflare-jev-output-v1', modelPinned: false };
}
export function semanticEndpoint(configured: string | undefined): string {
  if (!configured) invalid('no Cloudflare route is configured');
  let url: URL;
  try { url = new URL(configured); } catch { invalid('invalid configured route'); }
  if (url.origin !== 'https://api.cloudflare.com' || !/^\/client\/v4\/accounts\/[0-9a-f]{32}\/ai\/run$/.test(url.pathname) || url.search || url.hash || url.username || url.password) invalid('the route is not the selected Cloudflare AI endpoint');
  return url.href;
}
export function redactSemanticText(text: string): string {
  return text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:ghp_|github_pat_|sk_live_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED TOKEN]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED EMAIL]');
}
export async function evaluate(
  env: Env,
  state: unknown,
  questions: Record<string, Question>,
  template: string,
  budget: RequestBudget,
  privateSource = false
): Promise<Evaluation> {
  if (privateSource && env.FORGE_JEV_PRIVATE_SOURCE !== 'allow') throw new ForgeError({ code: 'FORGE_AUTH_REQUIRED', message: 'Private-source JEV processing is not permitted by this deployment. No source was sent to inference.' });
  if (!env.TYPESAFE_API_KEY?.trim()) invalid('no inference credential is configured');
  const endpoint = semanticEndpoint(env.TYPESAFE_BASE_URL);
  validateQuestions(questions);
  budget.semantic();
  const body = JSON.stringify({ model: 'typesafe/jev', input: { state, questions } });
  assertNoHighSeveritySecretText(body, 'JEV semantic processing');
  if (utf8Bytes(body) > 96 * 1024) throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: 'JEV stage exceeds its input budget.' });
  let response: Response;
  try {
    response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.TYPESAFE_API_KEY}` }, body, redirect: 'error', signal: AbortSignal.timeout(Math.min(6000, budget.remaining())) });
  } catch { invalid('the request timed out or the transport failed'); }
  if (!response.ok) {
    throw new ForgeError({ code: 'FORGE_UPSTREAM_UNAVAILABLE', message: `JEV returned HTTP ${response.status}. No automatic retry or substitute was used.`, details: { retryAfter: response.headers.get('retry-after') } });
  }
  if (!response.body) invalid('empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 64 * 1024) invalid('response exceeds its byte budget');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { invalid('response is not valid UTF-8 JSON'); }
  return parseEvaluation(raw, questions, template);
}
export function noul(evaluation: Evaluation, id: string): number {
  const answer = evaluation.answers[id];
  if (answer?.type !== 'noul') invalid(`required Noul ${id} is absent`);
  return answer.noul;
}
export function choice(evaluation: Evaluation, id: string): Extract<Answer, { type: 'choice' }> {
  const answer = evaluation.answers[id];
  if (answer?.type !== 'choice') invalid(`required Choice ${id} is absent`);
  return answer;
}
