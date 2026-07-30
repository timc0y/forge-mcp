# Security

- [`threat-model.md`](./threat-model.md) — assets, adversaries, boundaries.
- [`capability-tokens.md`](./capability-tokens.md) — signed, scoped, short-lived
  preview/action capabilities.
- [`approval-model.md`](./approval-model.md) — explicit user approval for
  sensitive actions (PR mutation, deploy, public preview, risky shell).
- [`trust-boundaries.md`](./trust-boundaries.md) — what crosses which boundary.
- [`network-policy.md`](./network-policy.md) — shell network policies.

## Cross-cutting rules enforced in code

- **Secret handling** — task summaries and evidence pass through redaction
  (`@forge/task-core` `redactSecrets`); compact diffs flag possible secret
  exposure in added lines (`@forge/insight`).
- **Structured app actions** — `@forge/app-actions` blocks payment/admin/identity
  patterns unless explicit test controls are set; functional and browser evidence
  stay distinct.
- **GitHub** — `forge_edit` writes only guarded `forge/` branches; raw executor
  pushes and default-branch writes are blocked; PR mutations require approval.
- **Evidence honesty** — a screenshot cannot be marked `passed`
  (`@forge/evidence`).
