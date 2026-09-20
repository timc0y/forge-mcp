import { describe, expect, it, vi } from 'vitest';
import { evaluate, parseEvaluation, semanticEndpoint, validateQuestions, type Question } from '../src/semantics';
import { RequestBudget } from '../src/evidence';
import type { Env } from '../src/env';

const questions: Record<string, Question> = {
  relevant: { type: 'noul', instructions: 'Does candidate A help the task?' },
  detail: { type: 'choice', instructions: 'Select required representation for candidate A.', criteria: { body: 'Full implementation', outline: 'Signature' } }
};
// Synthetic contract fixture. Not a claim of a captured production response.
const valid = () => ({ success: true, errors: [], result: { model: 'synthetic-model', answers: { relevant: { type: 'noul', noul: 0.8 }, detail: { type: 'choice', choice: 'body', confidence: 0.7, probabilities: { body: 0.8, outline: 0.2 } } }, usage: { input_tokens: 42, output_tokens: 7 } } });

describe('strict JEV contract', () => {
  it('retains probabilities, model identity and measured usage', () => {
    const result = parseEvaluation(valid(), questions, 'fixture/v1');
    expect(result.returnedModel).toBe('synthetic-model');
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    expect(result.modelPinned).toBe(false);
  });
  it('rejects missing answers, alternative envelopes and invented probabilities', () => {
    const missing = valid();
    Reflect.deleteProperty(missing.result.answers, 'relevant');
    expect(() => parseEvaluation(missing, questions, 'test')).toThrow(/missing/);
    expect(() => parseEvaluation(valid().result, questions, 'test')).toThrow(/Cloudflare/);
    const wrong = valid();
    wrong.result.answers.detail.probabilities.body = 0.3;
    expect(() => parseEvaluation(wrong, questions, 'test')).toThrow(/sum/);
    const confidence = valid();
    Reflect.deleteProperty(confidence.result.answers.detail, 'confidence');
    expect(() => parseEvaluation(confidence, questions, 'test')).toThrow(/Choice/);
  });
  it('accepts fractional scores only within their actual distribution', () => {
    const q: Record<string, Question> = { score: { type: 'score', instructions: 'Rate this.', criteria: ['low', 'high'] } };
    const response = { success: true, errors: [], result: { answers: { score: { type: 'score', score: 0.75, confidence: 0.5, probabilities: { '0': 0.25, '1': 0.75 } } } } };
    expect(parseEvaluation(response, q, 'test').usage).toBeNull();
    response.result.answers.score.score = 0.5;
    expect(() => parseEvaluation(response, q, 'test')).toThrow(/distribution/);
  });
  it('does not send private source without an explicit deployment policy', async () => {
    const request = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(evaluate({} as Env, { private: 'source' }, questions, 'test', new RequestBudget(), true)).rejects.toThrow(/not permitted/);
      expect(request).not.toHaveBeenCalled();
    } finally { request.mockRestore(); }
  });
  it('has exactly one permitted route and validates cardinality', () => {
    for (const url of [undefined, 'https://api.typesafe.ai/v1/systemone', 'https://evil.invalid/ai/run', 'http://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/ai/run']) expect(() => semanticEndpoint(url)).toThrow();
    expect(() => validateQuestions({ x: { type: 'score', instructions: 'rate', criteria: Array(11).fill('x') } })).toThrow(/2–10/);
  });
});
