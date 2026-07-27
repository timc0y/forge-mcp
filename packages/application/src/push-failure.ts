export type PushFailureCause =
  | 'disabled'
  | 'not_applicable'
  | 'auth'
  | 'capability_pin'
  | 'forge_proxy'
  | 'github_upstream'
  | 'verification_failed'
  | 'unknown';

export function classifyPushFailure(input: {
  reason?: string;
  stderr?: string;
  forgeErrorCode?: string;
}): PushFailureCause {
  const text = `${input.reason ?? ''}\n${input.stderr ?? ''}`.toLowerCase();
  if (input.reason === 'disabled' || input.reason === 'nothing to push' || input.reason === 'not an agent forge branch') {
    return 'not_applicable';
  }
  if (input.forgeErrorCode === 'FORGE_PERMISSION_DENIED' || text.includes('authorization') || text.includes('install the forge github app')) {
    return 'auth';
  }
  if (text.includes('commit scope') || text.includes('approved branch or commit') || text.includes('capability')) {
    return 'capability_pin';
  }
  if (text.includes('403') || text.includes('forbidden')) {
    return 'forge_proxy';
  }
  if (text.includes('remote ref did not match') || text.includes('could not verify')) {
    return 'verification_failed';
  }
  if (text.includes('rejected') || text.includes('422') || text.includes('non-fast-forward')) {
    return 'github_upstream';
  }
  return 'unknown';
}
