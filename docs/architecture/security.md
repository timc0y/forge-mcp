# Security Architecture

| Category | Security Controls / Policies |
|---|---|
| Auth & Access | OAuth subject validation, tenant/project authz, workspace revision checks, leases |
| Execution | Command classification, sandbox isolation, explicit network modes, scoped capabilities |
| Data & Audit | Output limits, redaction, explicit approvals, immutable audit events |
| Provider Routes | No lower-level route allows policy bypass |
| Sandbox Previews | Raw: internal service capability required. User-facing: Forge-authorized, expires independently |
