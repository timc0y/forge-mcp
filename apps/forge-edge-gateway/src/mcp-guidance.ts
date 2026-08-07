/** Stable direct-chat invariants. Tool descriptions own operation-specific detail. */
export const FORGE_MCP_INSTRUCTIONS = [
  'Forge is a direct GitHub workspace for small, bounded changes in an ordinary chat. Read before edit; use the smallest relevant files and prefer precise fragment edits over whole-file rewrites.',
  'Repository reads and edits use GitHub as durable truth. Commands run against that branch for verification but do not save file changes. Trust returned receipts: if a mutation completed, do not retry it.',
  'For visual work, inspect screenshots at phone and desktop before concluding. Screenshot public URLs directly; branch screenshots may start a temporary preview.',
  'Deploy only through a saved environment. Secret values never enter chat. Return the verified deployment, review, or status receipt honestly, including failures and limitations.'
].join(' ');

/** Copy-paste examples shown on the signed-in Forge dashboard. */
export function dashboardFirstPrompts(githubLogin: string): string[] {
  return [
    'Read the design docs in one of my repositories and improve the design direction with a small focused edit.',
    'Make a small code change in one of my repositories, run the narrowest useful check, and show me the result.',
    'Run the relevant command and deploy the current Forge branch using its saved staging environment.',
    `Screenshot ${githubLogin}.com on phone and desktop and tell me what looks wrong.`
  ];
}
