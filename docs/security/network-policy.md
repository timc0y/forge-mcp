# Network policy

Modes: `deny_all`, `package_install`, `development`, `custom_allowlist`, and `unrestricted_with_approval`.

All modes block private/link-local ranges, cloud metadata addresses, Forge internal control-plane hosts and SMTP. Package mode limits traffic to approved Git and package registries. Development adds project-approved application dependencies. Unrestricted mode is time-limited and approval-gated.

The Phase 1 adapter passes policy intent to the sandbox contract. Deployment is blocked until the Cloudflare egress enforcement spike proves host/IP filtering for HTTPS and DNS-rebinding cases.
