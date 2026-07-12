# Network policy

Modes: `deny_all`, `package_install`, `development`, `custom_allowlist`, and `unrestricted_with_approval`.

All modes block private/link-local ranges, cloud metadata addresses, Forge internal control-plane hosts and SMTP. Package mode limits traffic to approved Git and package registries. Development adds project-approved application dependencies. Unrestricted mode is time-limited and approval-gated.

The private-pilot adapter passes policy intent to the sandbox contract, but complete host/IP enforcement is not yet proven. Public hosted access remains blocked until the egress spike covers HTTPS, redirects and DNS rebinding.
