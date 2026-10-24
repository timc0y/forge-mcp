# Security

Report possible security issues privately before putting reproduction details
in a public issue or pull request.

## Contact

For Forge source or the maintainer-hosted service at `https://timcoy.uk/forge`,
use the LinkedIn contact link on [Tim Coy's website](https://timcoy.uk/).
Ask Tim for a private response route for a Forge security report. Keep that
first message to the affected component and a general description; send the
details only after a private route is agreed.

For someone else's self-hosted installation, contact its operator through its
privacy/contact page. The Forge maintainer cannot access or change that
operator's accounts or retained data. Report a source-code issue to the Forge
maintainer as well.

## What to include privately

- The affected source commit or deployed version, and whether it is the
  maintainer-hosted service or a self-host.
- The affected path, endpoint or tool, expected behaviour and observed behaviour.
- Minimal reproduction steps using accounts, repositories and public pages you
  control, plus the possible impact.
- Redacted evidence and a way to contact you.

Do not send live tokens, signing keys, OAuth codes, approval links, private
repository content or another person's data. Reproduce against your own
disposable setup; do not access other people's repositories or trigger paid
capture/inference on the maintainer's service to demonstrate a report.

There is no published response-time or fix-time commitment. Keep exploit details
private while discussing a fix and disclosure with the affected operator.

If you exposed a credential you control, revoke or rotate it with its provider.
Removing it from the current files does not remove it from Git history.
