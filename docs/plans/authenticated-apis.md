# Named APIs in Forge: design plan

## The person's path

Before: an API key lets Forge send requests, but it does not tell ChatGPT which requests exist.

After: the person signs in to the Forge dashboard.
The person adds a named API connection.
The person chooses Cloudflare, PostHog, Clarity, or Custom API.
The person gives the connection a name, such as `cf-1`.
The person enters the key.

Forge fills the known API host and OpenAPI URL for Cloudflare and PostHog.
Forge also fills how each known API receives the key.

OpenAPI is a file that lists API actions, their inputs, and their responses.

For PostHog, the person selects the US, EU, or own host.
For a Custom API, the person enters the host and an OpenAPI URL if one exists.
If no OpenAPI URL exists, the person adds a documented method and path in the dashboard.
The person can see these URLs before the connection is saved.
The person can change them before they save the connection.

For a Custom API, the person chooses a Bearer token, a named header, or a query field.
Forge shows where it will put the key before the person saves it.

The person then chooses which API actions Forge can use.
Developer connections start with all current documented actions.
The person can select a smaller set for a connection in the dashboard.
This choice controls the agent's access, not the rights of the API key at the provider.
The person can change the set at any time.

| Name | API host | API description | Key placement |
|---|---|---|---|
| `cf-1` | `https://api.cloudflare.com/client/v4/` | [Cloudflare OpenAPI JSON](https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json) | [Bearer token](https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/) |
| `posthog` | The person's PostHog host | That host's `/api/schema/` URL | [Bearer token](https://posthog.com/docs/api/links) |
| `clarity` | `https://www.clarity.ms/` | One action from the [Microsoft Data Export page](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api) | Bearer token |

The Microsoft page gives a Clarity endpoint, but the page does not give an OpenAPI URL.
Forge supplies that one action for Clarity.
The person does not have to make an OpenAPI file for it.

The dashboard shows a card for each connection.
The card shows the name, host, API description source, allowed actions, and last API result.
It shows separate states for “key saved”, “API description loaded”, and “API call succeeded”.
A saved key does not mean that the API accepted it.

An API action can be listed in the description even if the provider rejects this key.
The dashboard does not show the saved key again.
The person can test one chosen API action and see the actual status.
If Forge cannot read a description, the card shows the cause and does not claim that action search works.

## ChatGPT's path

Forge adds two MCP tools, `forge_api_search` and `forge_api_execute`.
Their names and inputs stay fixed when the person adds a connection.
Each tool gives a useful result even if the chat stops after that call.

1. ChatGPT asks `forge_api_search` for the person's connection names.
2. ChatGPT searches one named connection, such as `cf-2`, with short JavaScript code.
3. Forge runs that code against the API description in an isolated Worker.
4. Forge returns only matching actions, paths, and needed inputs.
5. ChatGPT sends short JavaScript code to `forge_api_execute`.
6. That code can call allowed API actions and work with their results.
7. Forge returns a short result and the status of each API call.

The key and the full OpenAPI file never enter the chat.
The JavaScript code cannot use the key or call the network directly.
It can request an API call only through Forge's host Worker.
The host Worker selects the saved key and fixed HTTPS host for the named connection.
It refuses a method or path that the person has not allowed.

One code run can read a list, use its IDs in later calls, and return a short answer.
The intermediate API responses stay out of the chat unless the code returns them.
If a later call fails, Forge reports which earlier calls succeeded.
ChatGPT does not treat a series of calls as one all-or-nothing change.

When the person names a connection, ChatGPT can search it without a separate list call.
If an action exists but is not allowed, Forge says how the person can enable it.
Forge gives distinct results for a missing action, a rejected key, and expired approval.

Cloudflare's OpenAPI file is [large](https://github.com/cloudflare/api-schemas/blob/main/openapi.json).
PostHog's file is also several megabytes.
Forge reads each file when the person saves or refreshes the connection.
Forge keeps the data needed for code search and API input checks.
The same API description can serve `cf-1` and `cf-2`.

Forge does not send the full file on every chat turn.
Forge treats text from an OpenAPI file as API data, not as instructions.
The file tells Forge which actions exist; it does not allow them by itself.
Forge uses the key method the person saved, even if the file describes other methods.

When an OpenAPI file changes, Forge shows new actions as off until the person allows them.
If an allowed action changes its method, path, or inputs, Forge stops that action until the person reviews it.

[Cloudflare's search and execute example](https://developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-openapi-mcp-server/) gives Forge a Worker pattern.
Its package is experimental and takes one OpenAPI file per MCP server.
Forge still needs one path for all named connections and its own approval rule.
[Solo's agentgateway](https://www.solo.io/blog/agentgateway-code-mode-for-openapi-to-mcp) also shows code mode over OpenAPI, but runs as a separate gateway.
[Stainless](https://www.stainless.com/docs/mcp/) generates code mode MCP servers from OpenAPI files, but needs a generated TypeScript SDK for each API.

## Approval with a time limit

The dashboard lets the person set “Ask me first” for a connection.
Cloudflare, Clarity, and PostHog can keep direct access if the person selects it.
A personal connection such as Monzo can use the stricter rule.

The person selects the actions that Forge may call for a strict connection.
The dashboard shows those actions before approval.
The person can approve those actions for 10 minutes.
The dashboard shows the allowed actions, end time, recent calls, and **End access**.
It states that this access applies to all chats signed in to the same Forge account.

The period of 10 minutes starts when the person selects **Approve** in the Forge dashboard.
Forge checks the account, connection, allowed actions, and end time before each API call inside the code.

Forge starts no new call after the time ends, even if the chat stays open.
A call that Forge already sent may finish after the time ends.
The person can end access early in the dashboard.
The agent cannot approve access or extend the time.

If ChatGPT asks for a locked connection, Forge returns a link to its approval page.
The link does not grant access by itself.
After the person approves, they can ask ChatGPT to continue the request.
Forge makes no API call before approval.
The person can also approve access in the dashboard before they ask ChatGPT.

Monzo also needs its own sign-in and token renewal for continued provider access.
The [Monzo Developer API](https://docs.monzo.com/) needs approval in the Monzo app before the token can read account data.
The provider sign-in and Forge's 10-minute access period are separate.
This plan does not put Monzo in the first release.

## Work in Forge

The dashboard and both MCP tools run in Forge's current Cloudflare Worker.
The agent code runs in a separate Dynamic Worker with no direct network access.
Forge keeps encrypted keys and API action lists in its D1 database.
The GitHub account in the Forge session selects the connection.
The caller cannot give another user ID or a new target host.

Forge sends keys only to the saved HTTPS host.
Forge does not send keys on redirects.
The tool and logs do not show keys or full request bodies.
Forge removes secret query values from the result and logs.

For direct connections, calls can use `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`.
Forge adds no approval step to those connections.
One code run can make several API requests.
Forge checks each request on the host Worker before it goes out.
Forge does not repeat an uncertain write.
The result shows each method, action, HTTP status, and a short response.

The [available guMCP snapshot](https://github.com/andrewtdiz/guMCP/tree/d76cabaa8711eadbf33061395d71aa2f4b8f2243) keeps [user keys](https://github.com/andrewtdiz/guMCP/blob/d76cabaa8711eadbf33061395d71aa2f4b8f2243/src/auth/clients/BaseAuthClient.py) separate from [agent actions](https://github.com/andrewtdiz/guMCP/blob/d76cabaa8711eadbf33061395d71aa2f4b8f2243/src/servers/airtable/main.py).
Forge keeps that useful split in its dashboard and two tools.

Forge has five MCP tools now.
The open draft [PR 83](https://github.com/timc0y/forge-mcp/pull/83) also changes tool registration.
The implementation must account for that PR before release.
The two new tools need one MCP version change and one client re-scan.
After that, a new dashboard connection must appear through the same tool without another re-scan.

## Proof before release

Proof uses two GitHub accounts and two Cloudflare keys with different rights.
The dashboard has Cloudflare, PostHog, and Clarity connections.
Forge reads both OpenAPI URLs within the Worker limits.
The Forge account can use [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/pricing/).
The Clarity action appears without an OpenAPI URL.

An ordinary ChatGPT conversation can list connections, search an action, and run code that calls it.
One code run can use a result from one API call in a later call.
The same chat can use a new connection without a re-scan.
The other GitHub account cannot see or use these connections.

The proof covers a read, a reversible write, a failed call, and a redirect.
Forge does not repeat an uncertain write.
Keys do not appear in chat, logs, or errors.

For a strict connection, the proof covers approval and calls during the period of 10 minutes.
It checks the end time before each API call inside one code run.
It covers early end and refusal after the time ends.
A different GitHub account cannot approve the connection.

The D1 change takes effect before Worker code uses it.
The release proof includes `pnpm check` and the production smoke check.
A new ChatGPT connection completes the full path again.

This design adds code execution to a Forge boundary that [currently excludes it](../../SIMPLE.md).
The product contract must reflect that choice before implementation.
No dashboard, key, approval period, OpenAPI import, or API tool is in place now.
