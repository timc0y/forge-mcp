/**
 * ChatGPT reads this when it decides which tool to call, and OpenAI's own
 * guidance is that the first 512 characters carry the most weight. So the
 * lead paragraph is exactly the five facts that change what the model does —
 * GitHub is the truth, an edit is already durable, Forge has one change branch,
 * the two lossy acts belong to a human, and eyes only reach
 * public pages — and it is kept under 512 characters so none of them falls off
 * the end. Everything the model can learn by reading a result is deliberately
 * not here.
 */
export const LEAD = [
  'GitHub is the truth. A forge_edit is on GitHub the moment it returns; nothing to push or confirm later.',
  'For plans, research, direction and routine content, edit the default branch. Use the one Forge change only when work needs human review.',
  'Every result lists the repo\'s open Forge change, so nothing has to be remembered.',
  'forge_merge and forge_discard only return a link a human opens to decide; it still works after this chat ends.',
  'forge_see needs a public URL; it returns images and a link to them.'
].join(' ');

const DETAIL = [
  'forge_read is the only way to look: no repo lists repositories, a repo shows its files and open changes, adding a change shows what it did, and adding paths returns file contents or that change\'s patches.',
  'forge_edit creates the repository if it does not exist. It commits directly unless change explains why the work needs review. Prefer replace fragments over whole files.',
  'Forge does not run, build, test, or deploy anything. If a result names limitations, say them.'
].join(' ');

export const INSTRUCTIONS = `${LEAD}\n\n${DETAIL}`;
