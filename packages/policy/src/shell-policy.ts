import { ForgeError } from '@forge/core';
import type { NetworkPolicyMode } from '@forge/sandbox-core';

// ADVISORY CLASSIFIER — NOT A SECURITY BOUNDARY.
//
// classifyCommand / assertCommandAllowed exist to decide *approval prompting* and
// *network-policy gating*. They are consumed to make real allow/deny + approval
// decisions (packages/application, forge-edge-gateway), but they are pattern
// matchers over a raw shell string, NOT a sandbox. They CANNOT contain a
// determined command: argument-level obfuscation (`cu''rl`, `python -c '...'`,
// base64 | sh, env-var indirection, symlinks) will always defeat token matching.
//
// GUARANTEES THIS MODULE PROVIDES:
//   - A command that syntactically matches a prohibited/destructive/install/
//     network pattern is escalated out of the auto-approve path.
//   - A command containing ANY shell control operator or command substitution
//     (see `shellControlOperators`) is NEVER classified read_only or
//     local_mutation. It is escalated to `requires_approval` so it can never
//     slip through the auto-approve path via a benign-looking prefix
//     (e.g. `git status && cat secrets`, `ls; python -c ...`).
//
// GUARANTEES IT DOES NOT PROVIDE:
//   - It does not prevent execution of a malicious command. Real isolation comes
//     from the sandbox container (non-root, dropped capabilities, no host mounts)
//     and the network egress policy enforced at connect/resolve time.
//   - It does not resolve hostnames or inspect network destinations. Egress
//     safety is the network layer's job (see assertPublicHost + caller-side
//     redirect/resolution re-checking).
//
// Treat a low-risk classification as "no obvious friction needed", never as
// "proven safe".

export type CommandClass =
  | 'read_only'
  | 'local_mutation'
  | 'dependency_install'
  | 'network_access'
  | 'external_side_effect'
  | 'privileged'
  | 'destructive'
  | 'prohibited'
  // Escalation bucket for commands that combine/obfuscate via shell control
  // operators or command substitution. Allowed to run, but NEVER auto-approved:
  // the human must approve because the effective command cannot be classified
  // from its leading token alone.
  | 'requires_approval';

// Shell control operators, command substitution, redirection and inline
// interpreter invocations. Presence of ANY of these means the command is a
// compound/obfuscated command whose real effect is not captured by the
// leading-token fast paths, so it must not be treated as low-risk.
//   ;  &&  ||  |  &  newline  `backtick`  $(  ${  >  <  sh -c / bash -c / *sh -c
const shellControlOperators: RegExp[] = [
  /;/,                       // sequencing
  /&&|\|\||&|\|/,            // and / or / background / pipe (covers single & and |)
  /[\r\n]/,                  // newline / carriage return
  /`/,                       // backtick command substitution
  /\$\(/,                    // $() command substitution
  /\$\{/,                    // ${} parameter/command expansion
  /[<>]/,                    // redirection (>, >>, <, here-doc/here-string)
  /(^|\s)(?:ba|z|da|a|k|c)?sh\s+-[a-z]*c(\s|$)/i // sh -c / bash -c / zsh -c / -lc etc.
];

export function hasShellControlOperators(command: string): boolean {
  return shellControlOperators.some((rule) => rule.test(command));
}

const prohibited = [
  /(^|\s)sudo(\s|$)/i,
  /(^|\s)(mount|umount|modprobe|insmod|rmmod)(\s|$)/i,
  /(^|\s)(iptables|nft)(\s|$)/i,
  /\/dev\/(mem|kmem|sd[a-z])/i,
  /docker\s+(run|build|exec).*--privileged/i,
  /(^|\s)(shutdown|reboot|poweroff)(\s|$)/i,
  /curl[^\n]*(169\.254\.169\.254|metadata\.google\.internal)/i,
  /(^|\s)(nc|netcat|socat)\s/i
];

const destructive = [/(^|\s)rm\s+-[^\n]*r[^\n]*f/i, /git\s+reset\s+--hard/i, /git\s+clean\s+-[^\n]*f/i];
const installs = [/(^|\s)(npm|pnpm|yarn|bun)\s+(install|add|i)(\s|$)/i, /(^|\s)(pip|uv)\s+install(\s|$)/i];
const network = [/(^|\s)(curl|wget|ssh|scp|rsync)(\s|$)/i];
const readOnly = [/^(pwd|ls|find|rg|grep|cat|head|tail|sed|git status|git diff|git log)(\s|$)/i];

export interface ShellDecision { classification: CommandClass; allowed: boolean; approvalRequired: boolean; reason: string; }

export function classifyCommand(command: string, networkPolicy: NetworkPolicyMode): ShellDecision {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 16_384 || trimmed.includes('\0')) {
    return { classification: 'prohibited', allowed: false, approvalRequired: false, reason: 'Command is empty, too large, or contains a NUL byte.' };
  }
  if (prohibited.some((rule) => rule.test(trimmed))) return { classification: 'prohibited', allowed: false, approvalRequired: false, reason: 'Command requests prohibited privileges or network access.' };
  if (destructive.some((rule) => rule.test(trimmed))) return { classification: 'destructive', allowed: false, approvalRequired: true, reason: 'Destructive command requires an approved capability.' };
  if (installs.some((rule) => rule.test(trimmed))) return { classification: 'dependency_install', allowed: networkPolicy !== 'deny_all', approvalRequired: true, reason: 'Dependency installation executes repository and package lifecycle scripts.' };
  if (network.some((rule) => rule.test(trimmed))) return { classification: 'network_access', allowed: ['development','custom_allowlist','unrestricted_with_approval'].includes(networkPolicy), approvalRequired: networkPolicy === 'unrestricted_with_approval', reason: 'Command accesses the network.' };
  // Compound/obfuscated commands must never fall through to the low-risk fast
  // paths below. A benign leading token (`git status`, `ls`) followed by a
  // control operator can hide an arbitrary second command, so escalate to
  // human approval instead of auto-approving. This runs AFTER the severe
  // pattern checks above so genuinely prohibited/destructive chains keep their
  // stronger (block) classification.
  if (hasShellControlOperators(trimmed)) return { classification: 'requires_approval', allowed: true, approvalRequired: true, reason: 'Command chains or obfuscates via shell control operators or substitution; requires explicit approval because its effective behavior cannot be classified automatically.' };
  if (readOnly.some((rule) => rule.test(trimmed))) return { classification: 'read_only', allowed: true, approvalRequired: false, reason: 'Read-only workspace command.' };
  return { classification: 'local_mutation', allowed: true, approvalRequired: false, reason: 'Command is confined to the isolated workspace.' };
}

/**
 * ADVISORY approval/network gate — despite the `assert` name this is NOT a
 * containment wall. It throws only for commands whose *syntax* matches a
 * blocked/approval-required class. It cannot stop an obfuscated command from
 * doing something dangerous once it runs; sandbox isolation + egress policy do
 * that. Callers must treat a returned decision as "no obvious friction needed",
 * not "proven safe". Kept under this name (and signature) because live callers
 * in @forge/application and @forge/edge-gateway import it; see module header
 * for the exact guarantees.
 */
export function assertCommandAllowed(command: string, networkPolicy: NetworkPolicyMode, hasApproval: boolean): ShellDecision {
  const decision = classifyCommand(command, networkPolicy);
  if (!decision.allowed) throw new ForgeError({ code: 'FORGE_COMMAND_BLOCKED', message: decision.reason, retryable: false, details: { classification: decision.classification } });
  if (decision.approvalRequired && !hasApproval) throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: decision.reason, retryable: false, details: { classification: decision.classification } });
  return decision;
}
