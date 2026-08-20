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
import { INSTRUCTIONS } from './instructions';

const SERVER_NAME = 'Forge';
const SERVER_VERSION = '1.0.0';

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

    registerTools(this.server, {
      env: this.env,
      identity,
      // Minted once per session against the user's own installation, so every
      // repository call spends their GitHub rate limit and not Forge's.
      gh: await githubRequest(this.env, identity.installationId),
      // Resolved on use, not on connect. Creating a repository is the only act
      // that needs to run as the human, and most sessions never do it — so the
      // stored credential is decrypted, and refreshed if stale, only when
      // something actually reaches for it.
      ghUser: async (path, init) => {
        const asUser = await userRequestFor(this.env, identity.userId);
        return asUser(path, init);
      }
    });
  }
}
