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
import { userRequestFor } from './user-token';
import { ForgeError } from './errors';
import { registerTools } from './tool-catalog';
import { analyticsFor } from './analytics';
import { INSTRUCTIONS } from './instructions';

const SERVER_NAME = 'Forge';
export const SERVER_VERSION = '2.2.0';

export class ForgeMcpSession extends McpAgent<Env, never, { identity: Identity }> {
  // Replaced in init: props are not hydrated until then, and the tools need
  // the caller's identity to be registered at all.
  server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { maxToolInputElements: 10_000 });

  async init(): Promise<void> {
    this.server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { instructions: INSTRUCTIONS, maxToolInputElements: 10_000 }
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
      // Resolve on every operation: GitHub user tokens enforce both the App's
      // grant and the human's current repository permissions. An installation
      // token would silently elevate an organization member's access.
      gh: async (path, init) => (await userRequestFor(this.env, identity.userId))(path, init),
      ghUser: async (path, init) => (await userRequestFor(this.env, identity.userId))(path, init)
    });
  }
}
