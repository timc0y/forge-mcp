# Ephemeral command-executor alternatives

**Decision context — 29 July 2026.** Forge's durable workspace is now GitHub:
the GitHub API owns file reads/writes, commits, branches and pull requests.
An executor is therefore deliberately disposable: it checks out the already
remote ref, runs commands, and may host a short-lived preview. It must never
become a second CRUD authority. This note compares only that job, using vendor
documentation (links are first-party and should be rechecked before a vendor
commitment).

## What the provider must supply

Lazy creation on the first `forge_shell`/preview request; an authenticated
checkout from the exact GitHub SHA; bounded `exec`, managed background
processes/logs, and an optionally exposed HTTP port; then destruction. Package
caches and a checkout may be retained only as performance caches. GitHub stays
the recovery path, so no provider snapshot is required for correctness.

The existing seam is suitable, but needs one intentional narrowing: retain
`create`, `get`, `destroy`, `exec`, process/log and port methods; make
`readFile`, `writeFile`, `applyPatch`, `listFiles`, `snapshot`, and `restore`
legacy Cloudflare capabilities rather than requirements of a new provider.
See [the current contract](../architecture/runtime.md) and
[`SandboxProvider`](../../packages/sandbox-core/src/contracts.ts).

## Comparison

| Option | Fit for command-only Forge | Runtime and persistence | Isolation / operational shape | Cost and capacity signal | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Cloudflare Sandbox** | Direct fit: command execution, long-running processes and port access are native SDK concepts ([SDK](https://developers.cloudflare.com/sandbox/), [ports](https://developers.cloudflare.com/sandbox/api/ports/)). | The provider has demonstrated the required lifecycle in production acceptance. Sandbox state is disposable; backup APIs are deliberately outside Forge's interface ([backups](https://developers.cloudflare.com/sandbox/api/backups/)). | Isolated Containers behind Workers; Forge already has the private Worker bridge. This is the lowest-change path, but the SDK remains pre-1.0 in this repository. | Consumption pricing and account limits are documented by Cloudflare ([pricing](https://developers.cloudflare.com/containers/pricing/), [limits](https://developers.cloudflare.com/containers/platform/limits/)). | **Keep as primary; E2B remains the first managed migration target.** |
| **E2B** | Strong API-shaped fit: Sandboxes execute commands, support background commands and expose ports ([sandbox API](https://e2b.dev/docs/sandbox), [ports](https://e2b.dev/docs/sandbox/ports)). | Sandboxes are ephemeral but can be paused/resumed; this is useful for warm command sessions, not durability ([lifecycle](https://e2b.dev/docs/sandbox/lifecycle)). | Purpose-built isolated code sandboxes; Forge would own checkout, GitHub token injection and egress policy. No Cloudflare-private preview bridge, so add a Forge proxy/capability layer. | Metered sandbox time; plan limits and current price are published on E2B's own pricing page ([pricing](https://e2b.dev/pricing)). | **Best hosted fallback / first migration target.** |
| **Modal Sandbox** | Good for one-off builds/tests: Sandbox runs arbitrary commands and supports web endpoints, but the product is primarily a general compute platform ([Sandboxes](https://modal.com/docs/guide/sandbox), [web server example](https://modal.com/docs/guide/webhooks)). | Explicit lifetime/timeout controls make it naturally disposable; do not use mounted volumes as Forge workspace state ([sandbox lifecycle](https://modal.com/docs/guide/sandbox#sandbox-lifecycle), [volumes](https://modal.com/docs/guide/volumes)). | Per-sandbox isolation with a mature Python-first control plane. A TypeScript gateway would call its API/CLI or a small Modal adapter service; preview authentication remains Forge's responsibility. | Per-second resource pricing and account quotas are vendor-managed ([pricing](https://modal.com/pricing), [limits](https://modal.com/docs/guide/limits)). | **Good build/test executor; weaker fit for interactive shell + preview UX.** |
| **Fly Machines** | A Machine can run a container and its process group; Fly Proxy can expose services ([Machines](https://fly.io/docs/machines/), [process groups](https://fly.io/docs/machines/process-groups/)). | Machines can stop/start and have optional volumes. Treat the root filesystem and volumes as caches only; a stopped Machine is not a correctness dependency ([autostop/autostart](https://fly.io/docs/launch/autostop-autostart/), [volumes](https://fly.io/docs/volumes/overview/)). | VM isolation and broad region choice, but Forge must build images, schedule/reap Machines, broker credentials, and harden public/private preview routing. | Pay for running VM and attached-volume resources; no useful zero-operations floor ([pricing](https://fly.io/docs/about/pricing/), [regions](https://fly.io/docs/reference/regions/)). | **Viable when regional placement or custom images matter; higher operator load.** |
| **GitHub Codespaces** | Technically excellent developer environment with dev containers, terminal and forwarded ports, but it is a user workspace product rather than a headless Forge executor ([overview](https://docs.github.com/en/codespaces/about-codespaces/what-are-codespaces), [ports](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace)). | Persistent environment until stopped/deleted, configurable idle timeout and retention; this conflicts with disposable, shared service execution unless each Forge tenant owns/authorizes it ([lifecycle](https://docs.github.com/en/codespaces/getting-started/deep-dive#the-codespace-lifecycle), [retention](https://docs.github.com/en/codespaces/setting-your-user-preferences/configuring-automatic-deletion-of-your-codespaces)). | GitHub supplies repository permissions and isolation, but service-side orchestration/API availability and billing attribution make this a poor default for Forge Cloud. | Usage is billed by compute/storage and constrained by personal/org quotas ([billing](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-codespaces/about-billing-for-github-codespaces), [quota](https://docs.github.com/en/codespaces/managing-codespaces-for-your-organization/managing-the-availability-of-github-codespaces-for-your-organization)). | **Offer only as a customer-owned, opt-in backend.** |
| **Self-hosted runner** | Simple command execution through GitHub Actions, including ephemeral runners; it is best for deterministic CI/deploy jobs, not interactive session RPC ([self-hosted runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners), [ephemeral runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/autoscaling-with-self-hosted-runners#ephemeral-runners-for-autoscaling)). | Forge can start a one-job runner and discard it. No persistent checkout needed; caches need deliberate poisoning and tenancy controls. | Full responsibility for host/VM isolation, network egress, image patching, runner registration and log forwarding. GitHub warns self-hosted runners can be compromised by untrusted workflow code ([security guidance](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#hardening-for-self-hosted-runners)). | Hardware/cloud bill is yours; GitHub-hosted minutes do not apply, and concurrency depends on your autoscaler and GitHub runner limits ([usage limits](https://docs.github.com/en/actions/reference/usage-limits-billing-and-administration)). | **Best low-cost private deployment or CI/deploy lane, not the hosted interactive default.** |

### Decision notes

- **Cold start / lazy start:** all six can be started only when a command
  arrives. E2B and Modal are the cleanest API-native choices. Fly can autostart
  Machines on traffic, but command-triggered scheduling is Forge work. Codespaces
  can create/start environments but carries user-workspace semantics. A runner
  must be registered before its workflow can accept a job.
- **Dev servers:** Cloudflare, E2B, Modal, Fly and Codespaces all have a
  documented port/web-service route. The Forge gateway must keep the preview
  capability and auth boundary regardless; never hand out a raw provider URL.
  GitHub Actions runners do not provide an equivalent managed preview ingress.
- **Regions:** Cloudflare, Modal and Fly document multi-region execution;
  E2B and Codespaces expose provider-selected/plan-dependent locations rather
  than a Forge-controlled global placement contract. Check the cited regional
  documentation and the account's current offer during procurement.
- **Security:** in every option, mint a short-lived GitHub installation token
  scoped to one repository, inject it only for checkout, redact it from logs,
  bound command/egress policy, and destroy the executor after inactivity or
  task completion. Treat arbitrary repository code as hostile.

## Ranked recommendation

1. **Repair and retain Cloudflare Sandbox** for the current Cloudflare-native
   deployment. It is the only option with the already-built provider, private
   preview bridge, and no migration cost. Do not claim production readiness
   until `/ready` completes a real provision/execute/destroy round trip.
2. **Add E2B behind the same provider seam** as the hosted escape hatch. Its
   sandbox and port primitives match the command-only contract closely while
   avoiding a bespoke scheduler.
3. **Use self-hosted ephemeral runners for private/self-host deployments and
   deploy/CI jobs**, where an operator accepts host responsibility and wants a
   low marginal-cost path.
4. **Modal** for bursty builds/tests where interactive previews are secondary.
5. **Fly Machines** only where geographic placement or custom long-lived image
   control outweighs the scheduler/network burden.
6. **Codespaces** only as a customer-funded opt-in environment, not Forge's
   multi-tenant executor.

## Migration seam and rollout

Keep `SandboxProvider` as Forge's internal name for compatibility, but define
the portable subset as `CommandExecutorProvider`: `createOrStart`, `exec`,
`startProcess`, `getProcess`, `readProcessLogs`, `stopProcess`, `exposePort`,
`revokePort`, and `destroy`. Provider IDs remain generated from a Forge
workspace ID and never reach clients. The adapter must accept a GitHub commit
SHA, not a writable filesystem as input; it performs a fresh checkout into an
ephemeral work directory on start. Remove core callers of filesystem mutation
methods first, then make snapshot/restore optional capability interfaces.

Roll out a second adapter with shadow lifecycle telemetry (create, checkout,
command, port, destroy), then opt in a small tenant allow-list. Require the
same acceptance contract for every provider: a fresh checkout of a known SHA,
a command result, managed process/log observation, authenticated preview,
destroy confirmation, and a clean re-run from GitHub alone. This makes a
provider outage lose only a cache, never a commit or branch.
