# Security

Report possible security issues privately before putting reproduction details
in a public issue or pull request.

## Contact

For Forge source,
use [GitHub’s private vulnerability report](https://github.com/timc0y/forge-mcp/security/advisories/new).
This sends the report privately to the repository maintainers; do not open a
public issue with exploit details.

For someone else's self-hosted installation, contact its operator through its
privacy/contact page. The Forge maintainer cannot access or change that
operator's accounts or retained data. Report a source-code issue to the Forge
maintainer as well.

## What to include privately

- The affected source commit or deployed version, and your self-host configuration with identifiers removed.
- The affected path, endpoint or tool, expected behaviour and observed behaviour.
- Minimal reproduction steps using accounts, repositories and public pages you
  control, plus the possible impact.
- Redacted evidence and a way to contact you.

Do not send live tokens, signing keys, OAuth codes, approval links, private
repository content or another person's data. Reproduce against your own
disposable setup; do not access other people's repositories or trigger paid
capture/inference on another operator’s service to demonstrate a report.

There is no published response-time or fix-time commitment. Keep exploit details
private while discussing a fix and disclosure with the affected operator.

If you exposed a credential you control, revoke or rotate it with its provider.
Removing it from the current files does not remove it from Git history.
