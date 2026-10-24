# Release status

Forge is open-source software for independent self-hosting. Tim's hosted copy is
private to him. This is the distribution decision made on 24 October 2026;
there is no public hosted preview, subscription or Marketplace launch planned.

## Source and deployment

Version **2.3.0** corrects expected-head writes and deletion, unconfirmed approval
outcomes, secret recognition and validation. It starts the public repository from
one initial commit; earlier history and release evidence are archived privately.
`FORGE_ALLOWED_LOGINS` admits only named GitHub accounts; missing, blank
or malformed configuration denies everyone. Maintainer production and development
name only `timc0y`. Existing bearer tokens, local development tokens, OAuth grants
and approval links retain the same restriction. A private GitHub App is additional
provider-side protection, not the runtime access check.

The [source release](https://github.com/timc0y/forge-mcp/releases/tag/v2.3.0) records
the published source and its checks. [Operations](./operating-forge.md) owns the
release procedure and dated deployment observations. The latest recorded private
deployment before this reset was 2.2.0. `/health` reports the running server version;
source publication alone does not establish deployment.

The source includes the MIT licence, contributor/security guidance, an independent
configuration template and a [self-hosting guide](./self-hosting.md). Self-hosts
create their own GitHub App and Cloudflare resources and pay their own provider
costs. Publishing the source does not give access to Tim's credentials or service.

## What has been proved

The preceding 2.1.0 deployment on 23 October 2026 passed 44 HTTP/OAuth checks and
existing-connection exact reads. Its migration, source hash and provider identities
remain recorded in Operations. These are dated observations, not proof of the
current client's cached catalogue or an independent installation.

Local regression tests cover source delivery/recovery, write conflicts and
uncertain outcomes, inference admission/accounting, exact selectors, private
access and approval ownership. The 30-case mocked context evaluation checks
plumbing; the six real-source questions validate their criteria against source.
Neither measures live hosted-JEV relevance.

Website checks cover seven complete Markdown guides, safe rendering, mounted
links, the local font, desktop/mobile reading and the illustrative example.
Current release checks and remaining limits belong in the release receipt.

## Remaining order

1. Refresh the maintainer's client catalogue, verify the running version and
   `forge_read.at`, then start a fresh conversation. Record read, a disposable
   edit and actual GitHub commit, merge/discard approval, and inline capture if
   enabled. In a disposable repository, verify expected-head updates and deletion
   through the App-user token when a concurrent push changes the head.
   Existing-client reads and HTTP checks do not establish that journey.
2. Have an independent consenting operator follow self-hosting with their own
   accounts, verify their first disposable commit and revoke access. Local config
   and SQLite fixtures are not an independently operated deployment.
3. Measure the six real-source questions against a pinned published revision.
   Keep necessary implementation/counter-evidence, follow-up count and cumulative
   reported usage. Missing usage is not proof of zero provider charge.
4. Keep capture consent restrictions while provider private-DNS, redirect and
   subrequest isolation remains unverified. Preserve shared inference caps and
   verify the operator's edge rules, spend notifications and actual bills.

These remaining observations do not turn the private deployment into a public
service. Reconsider public or paid hosting only after repeat use and explicit
requests for the maintainer to operate it; that needs its own decision about
spend, support and distribution.

## Client compatibility

The last recorded T3/Codex catalogue exposed all five tools but omitted
`forge_read.at`; refresh/re-scan and a new conversation remain required. Do not
promise identical read/write/approval behavior across every ChatGPT plan or
surface. Record actual client, plan, surface, server version and completed tasks.

## Security and costs

The private service still has public information, discovery and OAuth registration
routes. Public registration is needed before the caller's identity is known;
registration does not grant tool access. Operator rate limits and spend alerts
remain separate from per-person capture quotas and shared inference call caps.

Secret scanning covers publishable source and reachable Git history; synthetic
fixture matches are reviewed rather than hidden by broad exclusions. Current
scan and dependency-audit results are recorded with the release. Report source
security issues through [SECURITY.md](../SECURITY.md); contact a self-host's own
operator for their stored data or installation.
