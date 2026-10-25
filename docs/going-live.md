# Release checklist

Use this checklist when setting up or updating your Forge instance.

## Check the source

Run `pnpm check`, then the bundle and startup checks in
[operations](./operating-forge.md). Keep the release commit and your deployment
configuration together so you can return to a known version.

## Deploy

Follow [self-hosting](./self-hosting.md), apply migrations and deploy.
Check the version at `<FORGE_PUBLIC_ORIGIN>/health`, then run the smoke script
with your instance URL. Check log redaction, rate limits and spending alerts.

## Try your client

Refresh the connection after changing tool names or settings, then start a new
conversation. Read a test repository, make a small edit and open the commit on
GitHub. Try a proposed change and its merge or discard link. Check that an
account outside your access list is refused.

## Before inviting others

Choose who can connect and enable capture separately for people who consent.
Review the [capture restrictions](./using-forge.md#forge_see), provider costs and
privacy settings with anyone using your instance. Keep account IDs, credentials
and deployment records out of the public repository.
