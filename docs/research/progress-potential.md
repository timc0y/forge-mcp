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
S_t &=
\begin{cases}
0 & \Delta\Phi_t \\
S_{t-1}+1 & \neg\Delta\Phi_t \land \text{progress-seeking success}
\end{cases} \\
\text{refuse} &\iff S \ge K \text{ before the next progress-seeking call}
\end{aligned}
\]

\(W_t\) is a **durable witness**: `forge_edit` `commit_url`, merge submit, deps
`usable`, task create, workspace create. Observational tools (wait, read, get)
do not increment \(S\).

Secondary signal: Shannon entropy \(H_2\) of the last \(N\) `(tool, argsHash)`
pairs. High novelty with near-limit \(S\) trips **entropy thrash** (A↔B↔C
busywork).

This is a discrete Lyapunov / barrier certificate: trajectories that do not
decrease “stuckness” are cut. It is **not** a learned policy.

## Surface (KISS)

- One module: `packages/application/src/progress-potential.ts`
- One session DO key: `forge_progress_potential_v1`
- On trip: `FORGE_VALIDATION_FAILED` + `durabilityNextStep` + allowlist
  `forge_files_read` / `forge_edit`
- Soft Φ-warning one call before refuse, folded into receipts

Compose with `withRepeatDetection` (exact identical errors). Do not replace
shell write refuses or install-race gates.

## Defaults

| Symbol | Value |
| --- | --- |
| \(K\) | `PROGRESS_STREAK_LIMIT = 4` |
| \(N\) | `PROGRESS_ENTROPY_WINDOW = 8` |
| thrash | \(H_2 \ge 2.5\) bits near \(K\) |

## Status

Experimental. Tune \(K\) from production `mcp_tool_calls` if false positives
block legitimate verify loops; prefer raising \(K\) over deleting the gate.
