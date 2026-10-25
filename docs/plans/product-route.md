# Product route

Forge is MIT-licensed software for people who want a conversation to read GitHub
and save useful work as ordinary commits or draft pull requests.

## Distribution

The public site explains the product and leads to source and self-hosting.
Each operator supplies a GitHub App, Cloudflare resources, credentials and an
explicit GitHub account allowlist. Operators pay their providers; client plans
are separate. There is no public hosted offer, billing or waitlist.

## Public boundary

Publish setup instructions, architecture, limits and verification procedures.
Keep operator deployments, endpoints, account identifiers, configuration and
private test records outside the public repository and its history. The homepage
must not advertise a running instance or offer its App installation link.

## Evidence

[Release verification](../going-live.md) separates source checks, deployment,
client access and independent setup. [SIMPLE.md](../../SIMPLE.md) owns invariants;
[the context engine](./context-engine.md) owns the active architecture.
