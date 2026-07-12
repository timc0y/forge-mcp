# GitHub App research

Forge uses a GitHub App with repository metadata read, contents read/write and pull-request read/write only when enabled. Installation tokens are short-lived upstream credentials and must remain in the credential proxy. Webhook signatures are verified and event delivery is deduplicated.

Phase 1 is public clone. Private clone/push is blocked until the capability-bound credential proxy is deployed and tested.
