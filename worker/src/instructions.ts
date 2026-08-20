/**
 * ChatGPT reads this when it decides which tool to call, and OpenAI's own
 * guidance is that the first 512 characters carry the most weight. So the
 * lead paragraph is exactly the five facts that change what the model does —
 * GitHub is the truth, an edit is already durable, a change is named by intent
 * and not by a ref, the two lossy acts belong to a human, and eyes only reach
 * public pages — and it is kept under 512 characters so none of them falls off
 * the end. Everything the model can learn by reading a result is deliberately
 * not here.
 */
export const LEAD = [
  'GitHub is the truth. A forge_edit is on GitHub the moment it returns; nothing to push or confirm later.',
  'Never name a branch: describe the intent in a few words ("pricing section") and say those words again to continue that change.',
  'Every result lists the repo\'s open changes, so nothing has to be remembered.',
  'forge_merge and forge_discard only return a link a human opens to decide; it still works after this chat ends.',
  'forge_see needs a public URL; it returns images and a link to them.'
].join(' ');

const DETAIL = [
  'forge_read is the only way to look: no repo lists repositories, a repo shows its files and open changes, adding a change shows what it did, and adding paths returns file contents or that change\'s patches.',
  'forge_edit creates the repository if it does not exist and opens a draft pull request; it never writes to the default branch. Prefer replace fragments over resending a whole file.',
  'Forge does not run, build, test, or deploy anything. If a result names limitations, say them.'
].join(' ');

export const INSTRUCTIONS = `${LEAD}\n\n${DETAIL}`;
