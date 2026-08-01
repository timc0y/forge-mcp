/**
 * Agent-facing MCP instructions and prompt recipes.
 *
 * Kept in one module so guidance-integrity tests can sweep every forge_* name
 * ChatGPT/Claude will be told to call. Prefer short, imperative recipes —
 * weaker sessions follow these more reliably than abstract principles alone.
 */

export const FORGE_MCP_INSTRUCTIONS = [
  'Forge has two planes. GitHub is durable: forge_edit commits straight to your branch. The optional executor runs commands; files those commands change are disposable until you recreate them with forge_edit.',
  'Default loop for any project task: forge_task_create (goal, decisions, non-goals, likely_paths) → forge_workspace_create (it cuts the branch; never invent branch names) → forge_context_get / forge_files_read → forge_edit → smallest forge_shell or forge_deps_install check → forge_diff_metadata → forge_merge → echo approval_url only → forge_workspace_destroy. Optional: forge_start first and pass its branch as ref so the branch exists on origin before any workspace.',
  'Plans: write the plan into the durable task with forge_task_create / forge_task_update handoff fields. Prefer a short docs/plans/*.md via forge_edit only when the human asked for a repo-visible plan. Do not open an executor to plan.',
  'UI / design iteration: implement with forge_edit, then forge_preview (or forge_review for an already-deployed URL). Inspect every returned screenshot before the next edit. One coherent edit per turn; re-capture only the routes that changed.',
  'Bug fixes: reproduce with the cheapest evidence (forge_review URL, then forge_files_read, then forge_shell). Change the failing code and its test together in one forge_edit. Re-run the narrow check before broadening.',
  'Executor rules: the first shell/install/preview/deploy allocates compute. If it reports provisioning, call forge_workspace_get; if still provisioning, wait a few seconds and call forge_workspace_get again until ready, then retry the same execution tool — never create a second workspace. forge_process_wait is at most 30s per call — timedOut:true means observe again with the same process_id, never restart or raise the wait. Never git push. Deploys: forge_cloudflare_deploy → echo deploy_receipt.verified_url only.',
  'When context is compressed or the session reconnects: forge_task_get mode:resume (or forge_observer_workspaces if addressing is unclear), then continue from next_step. Do not create a second workspace for the same repository task.'
].join(' ');

export type ForgePromptName =
  | 'review-live-url'
  | 'start-task'
  | 'plan-work'
  | 'iterate-ui'
  | 'fix-bug'
  | 'resume-task'
  | 'prepare-draft-pr';

/** Each `hint` is the exact user turn the host injects. Keep forge_* names accurate. */
export const FORGE_PROMPT_HINTS: Record<
  ForgePromptName,
  (args: Record<string, string | undefined>) => string
> = {
  'review-live-url': ({ url, notes }) =>
    `Review the deployed site at ${url} with Parallax. Call forge_review first — it captures screenshots without starting a container — covering the key routes at phone and desktop viewports. Inspect every returned screenshot before reaching a verdict, and resolve or explicitly accept any structureSummary heading defects.${
      notes ? ` Focus on: ${notes}.` : ''
    }`,

  'start-task': ({ repository, task }) =>
    `Start a coding task on ${repository}: ${task}. Prefer forge_task_create, then forge_workspace_create and reuse workspace_id. Read and edit through GitHub immediately. The first execution tool starts the ephemeral executor; if it reports provisioning, poll forge_workspace_get until ready then retry that same tool — do not create a second workspace. Read repository instructions and any parallax/ files before changes. Implement and verify, inspect with forge_diff_metadata, then forge_merge. Tell me it is submitted and where to approve it, then destroy the workspace.`,

  'plan-work': ({ repository, goal }) =>
    `On ${repository}, create a durable plan for: ${goal}. Call forge_task_create with goal, decisions, non_goals, and likely_paths. Use forge_context_get and forge_files_read only as needed — do not allocate an executor. Summarise the plan back to me (outcome, scope, non-goals, acceptance). If I ask you to save it in-repo, write a short docs/plans note with forge_edit after forge_workspace_create; otherwise leave it on the task and stop.`,

  'iterate-ui': ({ repository, change }) =>
    `On ${repository}, iterate the UI: ${change}. Prefer forge_task_create (or forge_task_get mode:resume if a task already exists), then forge_workspace_create. Read the relevant components with forge_files_read, apply one coherent forge_edit, then verify with forge_preview at phone and desktop (use forge_review instead if a deployed URL already shows the change). Inspect every screenshot, fix only what the evidence shows, re-capture changed routes, then forge_diff_metadata and forge_merge when I say it looks right.`,

  'fix-bug': ({ repository, bug }) =>
    `On ${repository}, fix this bug: ${bug}. Prefer forge_task_create, then forge_workspace_create. Reproduce with the cheapest evidence first (forge_review if a URL is involved, otherwise forge_files_read / forge_shell). Change the failing code and its test together in one forge_edit. Re-run the narrowest failing check, then forge_diff_metadata and forge_merge. Echo the approval link only; destroy the workspace when done.`,

  'resume-task': ({ task_id, repository }) =>
    `Resume the Forge work${task_id ? ` for task ${task_id}` : repository ? ` on ${repository}` : ''}. Call forge_task_get with mode:resume${task_id ? ` and task_id ${task_id}` : ''}${
      !task_id ? ', or forge_task_list / forge_observer_workspaces if you lack the id' : ''
    }. Follow next_step. Reuse the existing workspace — do not forge_workspace_create a duplicate for the same repository task. Continue from the handoff; when finished, forge_merge, echo the approval link, and forge_workspace_destroy.`,

  'prepare-draft-pr': ({ workspace_id }) =>
    `Submit the current work for review${
      workspace_id ? ` in workspace ${workspace_id}` : ''
    } once tests pass. Run the tests and confirm they are green, inspect the outgoing change with forge_diff_metadata, then call forge_merge. It opens the draft pull request for me to approve whenever I get to it, so do not block waiting for an approval — report that it is submitted, tell me where to review it, and destroy the workspace.`
};

/** Copy-paste prompts shown on the signed-in Forge dashboard. */
export function dashboardFirstPrompts(githubLogin: string): string[] {
  return [
    `Plan the next change on one of my repositories: what to ship, non-goals, and acceptance checks. Do not write code yet.`,
    `On one of my repositories, improve the main landing UI. Iterate with screenshots until phone and desktop look right, then submit a draft PR.`,
    `Fix the most important bug you can prove in one of my repositories. Verify with the narrowest check or screenshots, then submit it for my review.`,
    `Screenshot ${githubLogin}.com on phone and desktop and tell me what looks wrong — no workspace unless we decide to change code.`
  ];
}
