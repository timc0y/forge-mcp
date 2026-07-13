# Malicious repository fixtures

These fixtures are inert descriptions used by policy and provider tests. They must not contain a live fork bomb or zip bomb.

- `postinstall/` attempts environment enumeration and outbound exfiltration.
- `network-scan/` attempts private-range and metadata access.
- `symlink/` describes a worktree symlink escape.
- `huge-output/` emits bounded synthetic output.

A deployed security test creates equivalent controlled behavior inside a disposable tenant and confirms command, network, output and path controls.
