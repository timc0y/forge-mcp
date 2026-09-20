import type { Analytics } from './analytics';
import type { Env } from './env';
import type { GitHubRequest, Identity } from './contracts';

export interface ToolContext {
  env: Env;
  identity: Identity;
  track: Analytics;
  gh: GitHubRequest;
  ghUser: GitHubRequest;
}
export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolOutcome {
  summary: string;
  structured: Record<string, unknown>;
  content?: Content[];
}
export interface ReadInput {
  repo?: string;
  change?: string;
  paths?: string[];
  query?: string;
  /** Explicit immutable revision, or proposal to read current proposal contents. */
  at?: string;
}
