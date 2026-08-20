# Market signal: ChatGPT-to-GitHub workflows

**Retrieved:** 20 August 2026  
**Method:** Treg searches of public X posts and public GitHub repository metadata  
**Status:** Dated demand signal, not market sizing

Engagement counts change after collection and X search is not a representative
sample. The useful question here is whether the behaviour exists strongly enough
to justify a focused product test, not how large the market is.

## Strongest signal: use the preferred ChatGPT model, then hand work to code

The clearest example is DevSpace, an MCP connector framed as turning ChatGPT into
Codex and using ChatGPT reasoning before handing work to a local coding agent.

| Evidence | Snapshot on retrieval |
|---|---:|
| [Original launch post](https://x.com/wshxnv/status/2066288292405080516) | 554,135 views · 1,579 likes · 2,111 bookmarks · 98 reposts · 117 replies |
| [Follow-up limits post](https://x.com/wshxnv/status/2067327251335835852) | 534,356 views · 1,606 likes · 2,468 bookmarks · 156 reposts · 85 replies |
| [Waishnav/devspace](https://github.com/Waishnav/devspace) | 3,882 stars · 430 forks · created 14 June 2026 · pushed 20 August 2026 |

The exact promise is not Forge's: DevSpace exposes an execution environment,
while Forge deliberately does not. The signal is the handoff itself — people
want the repository available in the conversation where they prefer to plan,
research or review.

## Directional signal: planning and delegating from a phone

- A [post about planning projects from bed on a phone with GPT
  Pro](https://x.com/doodlestein/status/1997408970961563726) had 16,690 views,
  94 likes and 73 bookmarks. Its friction was moving a long conversation into
  files and GitHub for a coding tool to consume.
- A [post about texting a coding system and receiving pull requests and website
  screenshots](https://x.com/MilesCranmer/status/2017613489812980129) had 6,489
  views, 69 likes and 60 bookmarks.

These examples validate the behaviour but do not prove that Forge's exact
interface is the winning implementation.

## Weaker signal: visual review

Searches found repeated examples of giving coding tools screenshot vision,
reviewing finished layouts and sending screenshots or annotated videos instead
of describing interface problems. No visual-review example in this sample had a
breakout demand signal comparable with DevSpace.

Treat visual review as a promising paid hypothesis. Validate it with actual
Forge users before adding a crawl, saved baselines or a review dashboard.

## Product consequences

- Lead with the safe handoff, not with MCP or limit arbitrage.
- Position Forge beside Codex and other coding agents, not against them.
- Demonstrate a complete job: research or vision in the conversation, durable
  evidence in GitHub, human control at merge.
- Keep the free five-tool core as acquisition until repeated use identifies a
  paid workflow.
