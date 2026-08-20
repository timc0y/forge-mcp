# ChatGPT availability for Forge

**Checked:** 20 August 2026  
**Status:** Time-sensitive; re-check official documentation before launch claims

This note separates documented product availability from one successful Forge
session. A live call proves that environment only; it is not a compatibility
contract for every plan, model, workspace or device.

## Documented availability

OpenAI currently documents the following:

| Surface | Custom MCP read/fetch | Custom MCP write/modify | Consequence for Forge |
|---|---|---|---|
| ChatGPT Business web | yes, admin-controlled | beta, admin/owner-controlled | plausible team target; test the published app and approval behaviour |
| ChatGPT Enterprise/Edu web | yes, RBAC-controlled | beta, action-controlled | strongest governance fit; test action refresh and access groups |
| ChatGPT Pro web developer mode | yes | no | `forge_read` and `forge_see` are the honest target; do not promise edits |
| Deep Research | read/fetch only | no | research may inspect GitHub or a public page, then a supported chat must perform the write |
| Agent mode | custom apps not used | no | not a Forge surface |
| Native ChatGPT mobile app | custom MCP apps documented as unavailable | unavailable | do not market native-mobile support without a new documented or observed result |

The Plugin Directory is now the primary discovery surface across ChatGPT and
Codex, but visibility does not mean every plan can install or invoke every app.
Plan, workspace settings, role and the capabilities of the underlying app still
decide access.

## Official sources

- [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta)
- [Plugins in ChatGPT and Codex](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex)
- [Apps in ChatGPT](https://help.openai.com/en/articles/11487775/apps-in-chatgpt)

## Required release matrix

Run and record direct, indirect and negative prompts for each environment that
can actually be obtained:

| Environment | Connect | Read | See images | Edit | Approval continuation | Status |
|---|---:|---:|---:|---:|---:|---|
| Pro web, read-only app |  |  |  | expected unavailable | n/a | untested |
| Business web, custom app |  |  |  |  |  | untested |
| Enterprise/Edu web, custom app |  |  |  |  |  | untested |
| Deep Research |  |  |  | expected unavailable | n/a | untested |
| Claude connector |  |  |  |  |  | untested in this plan |

Record the selected tool, arguments, confirmation card, elapsed time, returned
images, subsequent tool calls and whether another user message was required.

## Product consequences

- The landing page must say that client support varies by plan and surface.
- The free product needs a useful read-only path, not only a write story.
- Paid team validation should focus on workspaces where full MCP writes are
  documented and administrators value action controls.
- Phone/browser use is a workflow hypothesis to measure separately from native
  mobile availability.
- Limit and model availability may change; neither belongs in the permanent
  product promise.
