/**
 * Generic support for web applications that expose structured development or
 * testing actions. Nothing here is tied to one application or company: Forge
 * discovers a manifest of named actions, calls a selected action, runs a
 * sequence and evaluates simple assertions, recording safe summaries.
 *
 * Guardrails are explicit. This mechanism must never expose secrets, complete a
 * real financial transaction, mutate protected production administration, bypass
 * authorization, or alter real inventory/identity without test controls.
 */

export interface StructuredActionDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface StructuredActionManifest {
  schemaVersion: 1;
  tools: StructuredActionDef[];
}

export interface ActionCallResult {
  ok: boolean;
  summary: string;
  data: Record<string, unknown>;
}

/** A transport that actually reaches the protected preview. Injected, so the
 * discovery/sequence logic stays pure and unit-testable. */
export interface ActionTransport {
  manifest(): Promise<StructuredActionManifest>;
  call(name: string, input: Record<string, unknown>): Promise<ActionCallResult>;
}

/** Action-name patterns that are refused unless explicit test controls are set. */
const DANGEROUS_NAME = /(pay|payment|charge|checkout|refund|delete[_-]?user|admin|grant|promote|inventory[_-]?set|password|secret|token)/i;

export interface DiscoveryResult {
  schemaVersion: 1;
  actions: StructuredActionDef[];
  /** Actions withheld by policy, with the reason, rather than silently dropped. */
  blocked: Array<{ name: string; reason: string }>;
}

export interface DiscoverOptions {
  /** Opt-in to otherwise-blocked destructive actions in a test environment. */
  allowDangerous?: boolean;
}

export function classifyActions(
  manifest: StructuredActionManifest,
  options: DiscoverOptions = {}
): DiscoveryResult {
  const actions: StructuredActionDef[] = [];
  const blocked: DiscoveryResult['blocked'] = [];
  for (const tool of manifest.tools) {
    if (DANGEROUS_NAME.test(tool.name) && !options.allowDangerous) {
      blocked.push({ name: tool.name, reason: 'Matches a protected action pattern; requires explicit test controls.' });
    } else {
      actions.push(tool);
    }
  }
  return { schemaVersion: 1, actions, blocked };
}

export async function discoverActions(
  transport: ActionTransport,
  options: DiscoverOptions = {}
): Promise<DiscoveryResult> {
  return classifyActions(await transport.manifest(), options);
}

/** A single step in a structured journey with an optional assertion. */
export interface JourneyStep {
  action: string;
  input?: Record<string, unknown>;
  /** JSONPath-lite: dot path into the result checked for deep equality. */
  assert?: { path: string; equals: unknown };
}

export interface JourneyStepResult {
  action: string;
  callOk: boolean;
  summary: string;
  assertion?: { path: string; expected: unknown; actual: unknown; passed: boolean };
  state: 'passed' | 'failed' | 'blocked';
}

export interface JourneyResult {
  schemaVersion: 1;
  steps: JourneyStepResult[];
  /** passed only if every step's call and assertion passed. */
  state: 'passed' | 'failed' | 'partial' | 'blocked';
}

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

export async function runJourney(
  transport: ActionTransport,
  steps: readonly JourneyStep[],
  options: DiscoverOptions = {}
): Promise<JourneyResult> {
  const allowed = new Set(classifyActions(await transport.manifest(), options).actions.map((a) => a.name));
  const results: JourneyStepResult[] = [];
  for (const step of steps) {
    if (!allowed.has(step.action)) {
      results.push({ action: step.action, callOk: false, summary: 'blocked by policy', state: 'blocked' });
      continue;
    }
    const result = await transport.call(step.action, step.input ?? {});
    let assertion: JourneyStepResult['assertion'];
    if (step.assert) {
      const actual = readPath(result.data, step.assert.path);
      assertion = {
        path: step.assert.path,
        expected: step.assert.equals,
        actual,
        passed: JSON.stringify(actual) === JSON.stringify(step.assert.equals)
      };
    }
    const passed = result.ok && (assertion?.passed ?? true);
    results.push({
      action: step.action,
      callOk: result.ok,
      summary: result.summary,
      ...(assertion ? { assertion } : {}),
      state: passed ? 'passed' : 'failed'
    });
  }
  const state: JourneyResult['state'] = results.every((r) => r.state === 'passed')
    ? 'passed'
    : results.some((r) => r.state === 'blocked')
      ? 'blocked'
      : results.some((r) => r.state === 'passed')
        ? 'partial'
        : 'failed';
  return { schemaVersion: 1, steps: results, state };
}
