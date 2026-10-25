# Security

Report possible security issues privately before putting reproduction details
in a public issue or pull request.

## Contact

For source-code issues, use [GitHub’s private vulnerability report](https://github.com/timc0y/forge-mcp/security/advisories/new).
This sends the report privately to the repository maintainers; do not open a
public issue with exploit details.

For an issue with an instance, contact its operator using the contact details
they supplied. Only that operator can change their accounts or delete stored
data. Report any underlying source-code issue here too.

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

Keep exploit details private while discussing a fix and disclosure.

If you exposed a credential you control, revoke or rotate it with its provider.
Removing it from the current files does not remove it from Git history.
