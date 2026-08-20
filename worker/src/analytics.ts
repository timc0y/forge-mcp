import type { Env } from './env';

/**
 * Product analytics, on one rule: this may never change what a caller sees.
 *
 * Not the response, not the timing, not whether it succeeded. Analytics is the
 * lowest-value thing in the system and it sits on the hot path of the highest,
 * so every failure here is swallowed, every call is fire-and-forget, and an
 * unset API key makes the whole module a no-op rather than an error. If PostHog
 * is down, Forge does not notice.
 *
 * What is deliberately never sent: file contents, patches, commit messages,
 * intents, URLs captured, repository names, tokens. Those are the user's work.
 * What is sent is shape — which tool, whether it worked, how long it took —
 * because that is what tells you whether the product is usable, and none of it
 * needs to know what anyone wrote.
 */

export type ForgeEvent =
  | 'tool_called'
  | 'user_signed_up'
  | 'user_connected'
  | 'approval_requested'
  | 'approval_resolved'
  | 'capture_taken'
  | 'quota_refused';

export interface Analytics {
  (event: ForgeEvent, properties?: Record<string, string | number | boolean>): void;
}

/** PostHog's own default. Overridden for EU projects. */
const DEFAULT_HOST = 'https://us.i.posthog.com';

async function send(
  env: Env,
  distinctId: string,
  event: ForgeEvent,
  properties: Record<string, string | number | boolean>
): Promise<void> {
  const key = env.POSTHOG_API_KEY;
  if (!key) return;

  const host = (env.POSTHOG_HOST || DEFAULT_HOST).replace(/\/+$/, '');
  await fetch(`${host}/i/v0/e/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      event: `forge_${event}`,
      distinct_id: distinctId,
      properties: {
        ...properties,
        environment: env.FORGE_ENVIRONMENT,
        // PostHog would otherwise infer a location from the Worker's egress,
        // which is a datacentre and not where anybody is.
        $geoip_disable: true,
        $process_person_profile: true
      },
      timestamp: new Date().toISOString()
    })
  });
}

/**
 * Bind analytics to one identity.
 *
 * `waitUntil` keeps the request alive until the event is delivered where the
 * runtime offers it; without it the fetch is simply started and abandoned,
 * which loses events under load but never delays a reply. Losing an event is
 * the correct trade — the alternative is a tool call that waits on an
 * analytics vendor.
 */
export function analyticsFor(
  env: Env,
  distinctId: string,
  waitUntil?: (promise: Promise<unknown>) => void
): Analytics {
  return (event, properties = {}) => {
    const delivery = send(env, distinctId, event, properties).catch(() => {
      // Deliberately silent. A logged analytics failure is noise in the one
      // log a person reads when something real has gone wrong.
    });
    if (waitUntil) waitUntil(delivery);
  };
}

/** Analytics that go nowhere, for paths with no identity yet. */
export const noAnalytics: Analytics = () => {};
