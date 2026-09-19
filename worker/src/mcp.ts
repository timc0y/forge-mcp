/**
 * The MCP session: one Durable Object per connected client, holding a server
 * with exactly five tools on it.
 *
 * Nothing conversational is stored here. The session owns no task list, no
 * open workspace, no last-used repository — the client is a chat that may be
 * summarised between any two turns, so anything Forge kept here would be
 * state the chat could no longer address. What replaces it is the open-changes
 * list every tool result carries.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import type { Identity } from './contracts';
import type { Env } from './env';
import { githubRequest } from './github';
import { userRequestFor } from './user-token';
import { ForgeError } from './errors';
import { registerTools } from './tools';
import { analyticsFor } from './analytics';
import { INSTRUCTIONS } from './instructions';

const SERVER_NAME = 'Forge';
export const SERVER_VERSION = '1.1.1';

export class ForgeMcpSession extends McpAgent<Env, never, { identity: Identity }> {
  // Replaced in init: props are not hydrated until then, and the tools need
  // the caller's identity to be registered at all.
  server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  async init(): Promise<void> {
    this.server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { instructions: INSTRUCTIONS }
    );

    // The router authenticates before it ever reaches a session, so an absent
    // identity here is a wiring fault rather than an unauthenticated caller.
    // Failing loudly beats registering tools that would act as nobody.
    const identity = this.props?.identity;
    if (!identity) {
      throw new ForgeError({
        code: 'FORGE_AUTH_REQUIRED',
        message: 'This Forge session was started without an authenticated identity.',
        retryable: false
      });
    }

    // Keyed by the Forge user id, not the GitHub login: a login can be renamed
    // and the analytics would then show one person as two.
    const track = analyticsFor(this.env, identity.userId, (promise) => this.ctx.waitUntil(promise));
    track('user_connected');

    registerTools(this.server, {
      env: this.env,
      identity,
      track,
      // Bound to the user's installation. githubRequest reuses a fresh token,
      // refreshes before expiry and retries one 401, so long-lived MCP sessions
      // do not inherit a one-hour credential lifetime.
      gh: await githubRequest(this.env, identity.installationId),
      // Resolved on use, not on connect. Only new-repository creation and
      // explicit public GitHub search need to run as the human, so the stored
      // credential is decrypted/refreshed only when one of those paths is used.
      ghUser: async (path, init) => {
        const asUser = await userRequestFor(this.env, identity.userId);
        return asUser(path, init);
      }
    });
  }
}
