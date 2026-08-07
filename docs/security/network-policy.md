# Network policy

## Blocked by Default (All Modes)
Private/link-local ranges, cloud metadata addresses, internal control-plane hosts, SMTP.

## Policy Modes
| Mode | Allowed Traffic | Notes |
|------|-----------------|-------|
| `deny_all` | None | |
| `package_install` | Approved Git and package registries | |
| `development` | `package_install` + project-approved app dependencies | |
| `custom_allowlist` | User-defined | |
| `unrestricted_with_approval` | All | Time-limited, approval-gated |

## Implementation Status
- **private-pilot adapter:** Passes policy intent to sandbox contract; host/IP enforcement unproven.
- **Public hosted access:** Blocked until egress spike covers HTTPS, redirects, and DNS rebinding.
