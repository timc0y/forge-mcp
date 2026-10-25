# Research: Durable Progress Potential (Φ-gate)

Experimental control theory applied to ChatGPT↔MCP tool streams to block loops that return "success" but fail to progress durable repository state.

## Potential Model
Durable workspace state potential \(\Phi_t\) and verify-budget \(B_t\) are defined by:
\[
\begin{aligned}
\Phi_t &= H(\text{headSha},\;\text{depsStatus},\;\text{branch},\;\text{activeProcIds}) \\
\Delta\Phi_t &= \mathbf{1}[\Phi_t \neq \Phi_{t-1}] \lor W_t \\
B_t &=
\begin{cases}
B_{\max} & \Delta\Phi_t \\
\max(0, B_{t-1}-1) & \neg\Delta\Phi_t \land \text{success} \land B_{t-1}>0 \\
0 & \text{otherwise}
\end{cases} \\
S_t &=
\begin{cases}
0 & \Delta\Phi_t \\
S_{t-1} & B_t \text{ spent} \\
S_{t-1}+1 & \neg\Delta\Phi_t \land B_t=0 \land \text{success}
\end{cases} \\
\text{refuse} &\iff S_t \ge K \land B_t=0
\end{aligned}
\]

*   **Durable Witness (\(W_t\))**: Operations changing state (e.g. `forge_edit` commit receipt, merge submit, workspace create, verified deploy URL).
*   **Verify-Budget (\(B_{\max}\))**: Dwell credit of \(B\) operations allowing edits to be verified (tests, previews) without incrementing the stuckness count \(S\).
*   **Causal Certificate**: \(\text{tip}' = H(\text{tip} \Vert \text{tool} \Vert \text{id} \Vert t)\).
*   **Entropy Thrash**: Triggered when Shannon entropy \(H_2\) of the last \(N\) `(tool, args)` pairs is high (\(\ge 2.5\)) while \(S_t\) is near \(K\) and \(B_t=0\).

## API & Defaults

*   **Implementation**: `packages/application/src/progress-potential.ts`.
*   **Storage**: DO state key `forge_progress_potential_v1`.
*   **Gating**: Trips `FORGE_VALIDATION_FAILED` (instructs `forge_edit` or `forge_files_read`).

| Variable | Config Default | Description |
| :--- | :--- | :--- |
| \(K\) | `PROGRESS_STREAK_LIMIT = 4` | Maximum allowable non-progress steps. |
| \(B_{\max}\) | `PROGRESS_VERIFY_BUDGET = 6` | Post-witness verification budget. |
| \(N\) | `PROGRESS_ENTROPY_WINDOW = 8` | Shannon entropy evaluation window. |
