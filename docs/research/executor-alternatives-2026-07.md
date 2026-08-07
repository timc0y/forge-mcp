# Research: Ephemeral Command-Executor Alternatives

**Date**: 2026-07-29

Forge workspaces are transient caches of remote GitHub branches. Executors checkout commits, run validation commands, and expose previews container-free.

## Provider Comparison

| Option | Command Fit | Runtime & Lifecycle | verdict |
| :--- | :--- | :--- | :--- |
| **Cloudflare Sandbox** | Native SDK (ports/commands). | ephemereal/disposable. | **Primary provider**. |
| **E2B** | Strong API fit (custom sandboxes). | Pausable/resumeable. | **Hosted fallback / migration target**. |
| **Modal Sandbox** | Good build/test fit. | Explicit lifetime limits. | Good test runner; poor interactive terminal fit. |
| **Fly Machines** | Container VMs. Fly Proxy routing. | stopped machines are disposable. | Regional option; high operator burden. |
| **GitHub Codespaces** | Heavy developer environment. | Persistent. | Customer-owned opt-in backend only. |
| **Self-Hosted Runner** | CI/CD lane execution. | Ephemeral action jobs. | Low-cost private lane; higher security risk. |

## Migration Interface (`CommandExecutorProvider`)
To support multi-provider compatibility, restrict the integration seam to:
*   `createOrStart`
*   `exec`
*   `startProcess` / `getProcess` / `stopProcess`
*   `readProcessLogs`
*   `exposePort` / `revokePort`
*   `destroy`

Filesystem mutations (`readFile`, `writeFile`, `snapshot`, `restore`) are designated as Cloudflare-only or deprecated features. The provider receives a commit SHA and performs a fresh checkout on start.
