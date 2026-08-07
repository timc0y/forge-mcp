# Research: ChatGPT Chat as an MCP Host

**Date:** 2026-08-07

This note evaluates Forge's intended runtime: an ordinary ChatGPT conversation
using a custom MCP-backed app. It distinguishes that surface from ChatGPT Work,
Codex, Workspace Agents, and direct use of the Responses API.

## Executive conclusion

Ordinary **Chat** is documented as the fast conversational surface. **Work** is
the agent designed for longer, multi-step work, and **Codex** is the coding
agent. A model's ability to call MCP tools does not give ordinary Chat the
host-level persistence and autonomy of Work or Codex.

OpenAI does not publish a contractual maximum for consecutive MCP calls, model
tool rounds, or MCP call duration inside one ordinary Chat response. Therefore
Forge must not require a long client-side sequence to reach a useful outcome.
Each call should be independently useful, and long-running coding work should
continue durably behind the MCP interface.

## Product surfaces

OpenAI describes the surfaces as follows:

- **Chat:** quick conversational help, questions, search, and brainstorming.
- **Work:** an agent for longer, multi-step work and finished deliverables.
- **Codex:** an agent for software development, commands, tests, and repository
  work.

Source: [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex).

Custom MCP apps are usable in ChatGPT conversations, subject to plan, workspace,
region, and permission controls. Agent mode does not use custom apps; deep
research can use them only for read/fetch actions. Full MCP write support is
still plan- and workspace-dependent.

Sources: [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta),
[Apps in ChatGPT](https://help.openai.com/en/articles/11487775-apps-in-chatgpt).

### Consequence for Forge

The public MCP should be designed for Chat's conversational host, not for an
agent that happens to have fewer tools. If Forge requires persistent planning,
polling, retries, verification loops, or cleanup, Forge must own those operations
server-side.

## A Chat turn with an MCP app

The documented interaction is:

1. The user selects or mentions an app, or ChatGPT selects it from the available
   app tools.
2. The model chooses a tool using its name, description, schemas, annotations,
   and the MCP server's initialization instructions.
3. ChatGPT may show a permission or approval card before the call.
4. ChatGPT invokes the tool.
5. The model reads `structuredContent` and `content`, then answers or may choose
   another tool.

Tool metadata is user-facing model behavior, not merely documentation. Server
instructions are also used by ChatGPT and Codex; OpenAI recommends placing the
most important guidance in the first 512 characters.

Source: [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server).

ChatGPT can use multiple apps from one prompt. This demonstrates multi-tool
orchestration capability, but does not guarantee that an arbitrary dependent
chain will run to completion.

Source: [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta).

### What is not documented

OpenAI's public ChatGPT app documentation does **not** specify:

- a guaranteed number of consecutive tool calls within one assistant response;
- a guaranteed number of dependent tool-result/model rounds;
- a guaranteed MCP handler timeout;
- a guarantee that Chat will continue polling a pending operation;
- a guarantee that an opaque identifier remains salient after a long
  conversation or context reduction;
- a guarantee that the full model API context window is exposed by the ChatGPT
  product.

These omissions are product-interface facts, not evidence that the limit is one.
They mean a larger limit cannot be treated as a contract.

## Context and state across turns

An app may receive relevant information from the current ChatGPT conversation,
and Memory may provide additional relevant context when enabled. The docs say
"relevant context"; they do not promise the complete transcript or verbatim
retention of every prior tool result.

Source: [Apps in ChatGPT](https://help.openai.com/en/articles/11487775-apps-in-chatgpt).

Projects preserve project files, instructions, sources, and related chats, but
this is user-level context organization rather than a durable workflow-state
contract for an MCP server.

Source: [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt).

### Consequence for Forge

Workflow state must live in Forge and be recoverable by a human locator such as
repository plus active-change status. ChatGPT should not need to retain a task
ID, workspace ID, operation ID, process ID, preview ID, and approval ID.

## Write actions and approvals

Current ChatGPT app permissions can be configured as Always ask, Any changes,
Important actions, or Never ask where the account/workspace permits it. The
default is Important actions. Managed workspaces may constrain these choices,
and safety systems can still require or block an action.

Source: [Apps in ChatGPT — app permissions](https://help.openai.com/en/articles/11487775-apps-in-chatgpt).

The MCP security guide separately states that ChatGPT currently requires manual
confirmation before write actions. Because these first-party pages are not
perfectly aligned, a custom MCP should conservatively assume consequential
writes can introduce an approval boundary.

Source: [Building MCP servers — risks and safety](https://developers.openai.com/api/docs/mcp#non-prompt-injection-related-risks).

Accurate annotations are mandatory. Starting workflows, enqueueing jobs, and
creating internal records are not read-only merely because they do not yet push
code publicly.

Source: [MCP server review requirements](https://developers.openai.com/plugins/deploy/app-review).

### Consequence for Forge

Avoid a workflow with several separately confirmed lifecycle writes. One
clearly described request should authorize a durable Forge job whose permitted
effects are stated up front. Final merge or deployment should remain a distinct
human decision.

## Catalog discovery and updates

ChatGPT uses the tool names, titles, descriptions, input/output schemas,
annotations, `_meta`, and server instructions imported during tool scanning.
Published plugins use a reviewed metadata snapshot while calls continue to hit
the live MCP endpoint. Metadata changes require another scan and published
version; removing or incompatibly changing tools is a breaking change.

Source: [Published MCP metadata versions](https://developers.openai.com/plugins/deploy/app-review#how-published-mcp-metadata-versions-work).

OpenAI recommends one narrow outcome, approximately three to five focused tools,
concise `structuredContent`, and real ChatGPT developer-mode tests using direct,
indirect, and negative prompts.

Sources: [Bring your app to ChatGPT](https://learn.chatgpt.com/use-cases/chatgpt-apps),
[Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt).

### Consequence for Forge

Dynamic catalog filtering cannot be assumed on the published Chat surface.
Forge should publish a small stable interface. The existing low-level control
plane can remain private to Forge's own worker/agent implementation.

## GPT-5.6 Sol and Terra

Both models are reasoning models with the same published API envelope:

| Property | Sol | Terra |
|---|---:|---:|
| Positioning | Frontier capability | Intelligence/cost balance |
| Context window | 1,050,000 tokens | 1,050,000 tokens |
| Maximum input | 922,000 tokens | 922,000 tokens |
| Maximum output | 128,000 tokens | 128,000 tokens |
| MCP/function calling | Supported | Supported |
| Knowledge cutoff | 2026-02-16 | 2026-02-16 |

Sources: [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
[GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra).

These are API limits, not promises about how much context the ChatGPT product
will place in any particular Chat turn.

### Availability is the decisive difference

- In ordinary ChatGPT conversations, GPT-5.6 **Sol** powers Medium, High, and
  Extra High reasoning on eligible plans.
- GPT-5.6 **Terra is not selectable in ordinary Chat**.
- Sol, Terra, and Luna are selectable in ChatGPT Work and Codex on eligible
  plans.
- Apps are available with supported non-Pro models; Pro model modes do not use
  apps.

Sources: [GPT-5.6 in ChatGPT](https://help.openai.com/en/articles/20001354-gpt-56-in-chatgpt),
[Apps in ChatGPT](https://help.openai.com/en/articles/11487775-apps-in-chatgpt).

Therefore there is no ordinary-Chat-plus-Terra target to optimize for. Forge's
ordinary Chat target is Sol (and potentially the default fast Chat model). Terra
is relevant if Forge also supports Work, Codex, or uses Terra internally through
the API.

## Usage limits versus tool rounds

Apps have no separate ChatGPT rate limit; they follow the user's normal plan
limits, while the external app may impose its own limits.

Source: [Apps in ChatGPT](https://help.openai.com/en/articles/11487775-apps-in-chatgpt).

Work and Codex usage is variable: model, context, reasoning, retrieval, caching,
and tool use all influence how much a message consumes. Published message ranges
are therefore estimates, not fixed tool-call budgets.

Source: [ChatGPT Work and Codex pricing](https://learn.chatgpt.com/docs/pricing#what-are-the-usage-limits-for-my-plan).

"Messages per time window" and "tool rounds within one message" are different
limits. OpenAI publishes the former for some products and plans, but not a
contractual value for the latter in ordinary Chat.

## Recommended Forge interface

The research changes the proposed architecture. A four-call client-side coding
loop still assumes too much autonomy from ordinary Chat. Forge should instead
act as a durable job system with an agent behind it:

1. `forge_list_repositories` — resolve ambiguity.
2. `forge_plan_change` — start or return a repository-backed planning job.
3. `forge_start_change` — authorize one durable coding job, including branch,
   edits, verification, and preparation for human review.
4. `forge_get_change` — read progress, evidence, failures, or the review link;
   recover by repository when the ID is absent.
5. `forge_update_change` — add human feedback and queue another bounded pass.
6. `forge_review_site` — start or retrieve a URL-review job.

The coding agent behind these tools may use the existing task, workspace, file,
shell, process, preview, diff, and submission handlers privately. Terra is a
sensible default internal worker; Sol can be selected for ambiguous or failed
tasks. That model choice is independent of the model hosting the user's Chat.

Every public call should:

- return a useful outcome even if ChatGPT makes no further call;
- complete quickly or return a durable job that continues server-side;
- use one human-recoverable change identifier at most;
- provide a concise status, evidence, and one suggested next user action;
- avoid requiring ChatGPT to poll, clean up, or remember a `finally` step;
- expose strict, minimal output schemas;
- be idempotent across retries and approval resumptions.

## Validation required before finalizing the interface

The undocumented host limits must be measured in ChatGPT developer mode rather
than guessed. Test at least:

- ordinary Chat with Sol Medium and High;
- the default fast Chat model;
- direct, indirect, and negative tool-selection prompts;
- one read call, read-then-write, and attempted three-plus-call chains;
- approval continuation under each available app permission setting;
- 5 s, 20 s, and deliberately asynchronous handlers;
- loss of an opaque ID followed by recovery using only the repository name;
- long conversations where earlier tool results are no longer recent;
- metadata changes before and after re-scanning the app.

Record selected tool, arguments, approvals, elapsed time, subsequent tool calls,
final answer completeness, and whether the user had to send another message.
Those observations should become Forge's compatibility contract; undocumented
behavior should not become a product invariant.
