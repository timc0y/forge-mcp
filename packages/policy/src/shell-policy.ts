import { ForgeError } from '@forge/core';
import type { NetworkPolicyMode } from '@forge/sandbox-core';

// IMPORTANT: this is NOT a security boundary. These regexes classify commands to
// decide approval prompting and network policy — they are trivially bypassed
// (`cu''rl`, `python -c '...'`, pipes, `$()`), so they must never be relied on to
// *contain* a command. Real isolation comes from the sandbox container (non-root,
// dropped capabilities, no host mounts) and the network egress policy. Treat this
// as best-effort friction that surfaces obviously-risky commands to the human,
// not as a wall.

export type CommandClass = 'read_only' | 'local_mutation' | 'dependency_install' | 'network_access' | 'external_side_effect' | 'privileged' | 'destructive' | 'prohibited';

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
  if (readOnly.some((rule) => rule.test(trimmed))) return { classification: 'read_only', allowed: true, approvalRequired: false, reason: 'Read-only workspace command.' };
  return { classification: 'local_mutation', allowed: true, approvalRequired: false, reason: 'Command is confined to the isolated workspace.' };
}

export function assertCommandAllowed(command: string, networkPolicy: NetworkPolicyMode, hasApproval: boolean): ShellDecision {
  const decision = classifyCommand(command, networkPolicy);
  if (!decision.allowed) throw new ForgeError({ code: 'FORGE_COMMAND_BLOCKED', message: decision.reason, retryable: false, details: { classification: decision.classification } });
  if (decision.approvalRequired && !hasApproval) throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: decision.reason, retryable: false, details: { classification: decision.classification } });
  return decision;
}
