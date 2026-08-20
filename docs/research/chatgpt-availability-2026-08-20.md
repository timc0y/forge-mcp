# ChatGPT availability for Forge

**Checked:** 20 August 2026  
**Status:** Time-sensitive; re-check official documentation before launch claims

This note compares documented product availability with a successful production
Forge session. They do not currently agree in every respect. A live call is the
strongest evidence for that environment, while public documentation is the safer
basis for claims about accounts that have not been tested.

## Directly observed in ChatGPT

In a production ChatGPT web session on 20 August 2026, Forge was not read-only:

- `forge_edit` created durable commits and a draft pull request in a real private
  repository;
- repeated edits with the same human intent continued the same change;
- `forge_read` recovered and inspected that change in later turns;
- `forge_merge` and `forge_discard` both prepared durable human approval links;
- `forge_see` returned phone and desktop images inline and at a signed link.

The session was running in a browser on an iPhone, rather than the native
ChatGPT mobile app. This proves full write-tool availability in that exact
ChatGPT runtime. It does not reveal whether the reason is an account setting, a
staged rollout, a developer-MCP exception or a wider undocumented change.

The earlier description of Forge as read-only on this ChatGPT side was therefore
too categorical. The accurate statement is: **OpenAI documents narrower Pro
availability, while this production session directly demonstrated writes.**

## Documented availability

OpenAI currently documents the following:

| Surface | Custom MCP read/fetch | Custom MCP write/modify | Consequence for Forge |
|---|---|---|---|
| ChatGPT Business web | yes, admin-controlled | beta, admin/owner-controlled | plausible team target; test the published app and approval behaviour |
| ChatGPT Enterprise/Edu web | yes, RBAC-controlled | beta, action-controlled | strongest governance fit; test action refresh and access groups |
| ChatGPT Pro web developer mode | yes | no | official documented position; direct production observation below demonstrates that some ChatGPT runtimes expose writes |
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
| Observed production ChatGPT web session | yes | yes | yes | yes | links prepared; completion untested | observed 20 August 2026 |
| Fresh Pro web account |  |  |  | public docs say unavailable | n/a | untested independently |
| Business web, custom app |  |  |  |  |  | untested independently |
| Enterprise/Edu web, custom app |  |  |  |  |  | untested |
| Deep Research |  |  |  | expected unavailable | n/a | untested |
| Claude connector |  |  |  |  |  | untested in this plan |

Record the selected tool, arguments, confirmation card, elapsed time, returned
images, subsequent tool calls and whether another user message was required.

## Product consequences

- The landing page must say that client support varies by account, rollout,
  plan and surface.
- Do not describe Forge itself as read-only: its complete write path works in
  the observed ChatGPT runtime.
- Keep a useful read-only path because other accounts and Deep Research may
  still expose only read/fetch tools.
- Team validation remains commercially useful because Business and
  Enterprise/Edu write controls are publicly documented and governable.
- Browser use on a phone is distinct from the unsupported native mobile app.
- Limit and model availability may change; neither belongs in the permanent
  product promise.
