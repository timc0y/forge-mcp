# GitHub App research

Forge uses a GitHub App with repository metadata read, contents read/write and pull-request read/write only when enabled. Installation tokens are short-lived upstream credentials and must remain in the credential proxy. Webhook signatures are verified and event delivery is deduplicated.

The private pilot is public-clone only. Private clone and push remain blocked until the capability-bound credential proxy is deployed and tested.
