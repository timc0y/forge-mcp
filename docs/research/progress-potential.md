# Durable Progress Potential (Φ-gate)

Unproven but classical control theory applied to ChatGPT↔MCP tool streams.

## Problem

Identical-failure detection catches `tool(args)→error` loops. It misses the
commoner spiral: **successful** `forge_shell` / preview / install cycles that
never move durable GitHub state. Exit 0 feels like progress; Φ says it is not.

## Model

Treat durable workspace truth as a discrete potential \(\Phi\):

\[
\begin{aligned}
\Phi_t &= H(\text{headSha},\;\text{depsStatus},\;\text{branch},\;\text{activeProcIds}) \\
\Delta\Phi_t &= \mathbf{1}[\Phi_t \neq \Phi_{t-1}] \lor W_t \\
B_t &=
\begin{cases}
B_{\max} & \Delta\Phi_t \\
\max(0, B_{t-1}-1) & \neg\Delta\Phi_t \land \text{progress-seeking success} \land B_{t-1}>0 \\
0 & \text{otherwise}
\end{cases} \\
S_t &=
\begin{cases}
0 & \Delta\Phi_t \\
S_{t-1} & B_t \text{ spent (verify credit)} \\
S_{t-1}+1 & \neg\Delta\Phi_t \land B=0 \land \text{progress-seeking success}
\end{cases} \\
\text{refuse} &\iff S \ge K \text{ before the next progress-seeking call (and } B=0\text{)}
\end{aligned}
\]

\(W_t\) is a **durable witness**: `forge_edit` `commit_url`, merge submit, deps
`usable`, task create, workspace create, Cloudflare deploy `verified_url`.
Observational tools (wait, read, get) do not increment \(S\).

**Verify-budget** \(B_{\max}\): after a witness, up to \(B\) progress-seeking
successes (tests / shell / preview) spend dwell credit instead of growing \(S\).
That shields legitimate edit→test→edit loops from false refuses.

**Causal certificate**: each witness extends
\(\text{tip}' = H(\text{tip} \Vert \text{tool} \Vert \text{id} \Vert t)\).
Receipts expose `witness_tip` + `witness_depth` so “done” claims can be checked
against an unbroken session chain.

**Live Φ**: `phiFromReceipt` fingerprints head/deps/branch/procs from tool
receipts when present; \(\Delta\Phi\) alone can count as a witness.

Secondary signal: Shannon entropy \(H_2\) of the last \(N\) `(tool, argsHash)`
pairs. High novelty with near-limit \(S\) and exhausted \(B\) trips **entropy
thrash** (A↔B↔C busywork).

This is a discrete Lyapunov / barrier certificate: trajectories that do not
decrease “stuckness” are cut. It is **not** a learned policy.

## Surface (KISS)

- One module: `packages/application/src/progress-potential.ts`
- One session DO key: `forge_progress_potential_v1`
- On trip: `FORGE_VALIDATION_FAILED` + `durabilityNextStep` + allowlist
  `forge_files_read` / `forge_edit`
- Soft Φ-warning one call before refuse, folded into receipts
- Compact `progress_potential` view: streak, verify_budget, phi, tip, depth

Compose with `withRepeatDetection` (exact identical errors). Do not replace
shell write refuses or install-race gates.

## Defaults

| Symbol | Value |
| --- | --- |
| \(K\) | `PROGRESS_STREAK_LIMIT = 4` |
| \(B_{\max}\) | `PROGRESS_VERIFY_BUDGET = 6` |
| \(N\) | `PROGRESS_ENTROPY_WINDOW = 8` |
| thrash | \(H_2 \ge 2.5\) bits near \(K\) with \(B=0\) |

## Status

Experimental. Prefer raising \(B\) or \(K\) from production `mcp_tool_calls`
over deleting the gate if false positives block long verify loops.
Next hardening: bind Φ to workspace DO state (not only receipts).
