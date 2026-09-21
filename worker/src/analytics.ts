import type { Env } from './env';

/** Shape-only observations in the existing Cloudflare logs. No external analytics transport. */
export type ForgeEvent =
  | 'tool_called' | 'user_signed_up' | 'user_connected' | 'change_committed'
  | 'approval_requested' | 'approval_resolved' | 'capture_taken' | 'quota_refused'
  | 'context_compiled';
export interface Analytics {
  (event: ForgeEvent, properties?: Record<string, string | number | boolean>): void;
}
const SHAPE_KEYS = new Set([
  'tool', 'ok', 'code', 'ms', 'files', 'created_repo', 'viewports', 'images',
  'action', 'act', 'outcome', 'decision', 'success', 'bytes', 'output_bytes',
  'input_bytes', 'github_calls', 'candidates', 'selected', 'jev_stages',
  'input_tokens', 'output_tokens', 'truncated', 'coverage', 'commits', 'requested', 'captured', 'failures'
]);
const SAFE_LABEL = /^[a-zA-Z0-9_-]{1,64}$/;
export function safeMetricProperties(properties: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!SHAPE_KEYS.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'boolean') result[key] = value;
    else if (typeof value === 'string' && SAFE_LABEL.test(value)) result[key] = value;
  }
  return result;
}
export function analyticsFor(env: Env, _distinctId: string, _waitUntil?: (promise: Promise<unknown>) => void): Analytics {
  return (event, properties = {}) => {
    try {
      console.info('forge_metric', { event, environment: env.FORGE_ENVIRONMENT, ...safeMetricProperties(properties) });
    } catch {
      // Observation failure cannot change a durable operation or its receipt.
    }
  };
}
export const noAnalytics: Analytics = () => {};
