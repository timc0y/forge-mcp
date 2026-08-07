import { ForgeError } from '@forge/core';
import type { NetworkPolicyMode } from '@forge/sandbox-core';

// ADVISORY CLASSIFIER — NOT A SECURITY BOUNDARY.
//
// Drives approval prompting and network gating, not sandbox isolation.
// Defeated by obfuscation. Evaluates commands segment-by-segment (split on control operators),
// surfacing the highest severity segment to determine approval/blocking.
//
// Guarantees provided:
// - Patterns matching prohibited/destructive/network rules trigger escalation.
// - Unparseable structures fall back to requires_approval.
//
// Guarantees NOT provided:
// - Does NOT prevent malicious execution (handled by sandbox/egress policy).
// - Does NOT parse non-shell payloads (`python -c`, etc.).
// - Does NOT validate hostnames/network destinations.

export type CommandClass =
  | 'read_only'
  | 'local_mutation'
  | 'dependency_install'
  | 'network_access'
  | 'external_side_effect'
  | 'privileged'
  | 'destructive'
  | 'prohibited'
  // Requires human approval; executes argument/file as shell.
  | 'shell_evaluation'
  // Unparseable structure. Runs but requires approval.
  | 'requires_approval';

// Worst-wins severity ordering.
const SEVERITY: Record<CommandClass, number> = {
  read_only: 0,
  local_mutation: 1,
  network_access: 2,
  external_side_effect: 3,
  dependency_install: 4,
  requires_approval: 5,
  shell_evaluation: 5,
  destructive: 6,
  privileged: 7,
  prohibited: 8
};

// Cheap compound command check. Does not drive approval.
const shellControlOperators: RegExp[] = [
  /;/,
  /&&|\|\||&|\|/,
  /[\r\n]/,
  /`/,
  /\$\(/,
  /\$\{/,
  /[<>]/,
  /(^|\s)(?:ba|z|da|a|k|c)?sh\s+-[a-z]*c(\s|$)/i
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
const installs = [/(^|\s)(npm|pnpm|yarn|bun)\s+(install|ci|add|i)(\s|$)/i, /(^|\s)(pip|uv)\s+install(\s|$)/i];
const network = [/(^|\s)(curl|wget|ssh|scp|rsync)(\s|$)/i];

// Live cloud account mutations. Matches wrangler deployments/wrappers.
const WRANGLER_WRAPPER = '(?:(?:npx|bunx|pnpm\\s+(?:dlx|exec)|yarn\\s+dlx)\\s+)?';
const WRANGLER_MUTATING =
  /(?:deploy|publish|delete|versions\s+deploy|containers\s+deploy|rollback)\b/i;
const WRANGLER_EXTERNAL = new RegExp(
  `(^|\\s)${WRANGLER_WRAPPER}wrangler\\s+${WRANGLER_MUTATING.source}`,
  'i'
);

function isExternalWranglerCommand(scrubbed: string): boolean {
  if (!WRANGLER_EXTERNAL.test(scrubbed)) return false;
  // `--dry-run` never mutates a live account; keep it out of the approval path.
  if (/(^|\s)--dry-run(\s|$)/i.test(scrubbed)) return false;
  return true;
}

// Read-only commands. `sed` handled separately due to `-i` mutation.
const readOnly = [
  /^(pwd|ls|ll|find|rg|grep|egrep|fgrep|cat|bat|head|tail|wc|sort|uniq|cut|tr|basename|dirname|stat|file|du|df|tree|which|type|echo|printf|true|false|date|whoami|id|env|printenv|realpath|readlink|diff|cmp|md5sum|sha256sum)(\s|$)/i,
  /^git\s+(status|diff|log|show|branch|remote|config\s+--get|rev-parse|describe|blame|ls-files|ls-tree|cat-file|shortlog|tag\s*$)(\s|$)/i,
  /^(node|python3?|ruby|perl)\s+--version(\s|$)/i,
  /^(npm|pnpm|yarn|bun|cargo|go|deno)\s+(--version|-v|list|ls|why|outdated|view|info)(\s|$)/i
];

// `sed` with `-i` mutates files; otherwise read-only stream filter.
const SED_IN_PLACE = /^sed\s+[^\n]*(-i(\b|[a-z0-9.]*)|--in-place)/i;
const SED = /^sed(\s|$)/i;

export interface ShellDecision {
  classification: CommandClass;
  allowed: boolean;
  approvalRequired: boolean;
  reason: string;
}

interface Segment {
  /** Raw text. */
  text: string;
  /** Scrubbed text: quotes replaced with placeholder. */
  scrubbed: string;
  /** Segment redirect output to file. */
  writesFile: boolean;
}

/** Quoted literal placeholder. */
const QUOTED_ARG = 'ARG';

interface SplitResult {
  segments: Segment[];
  /** Parsing failed. */
  parseFailed: boolean;
}

const MAX_SEGMENTS = 64;
const MAX_SUBSTITUTION_DEPTH = 8;

/**
 * Splits shell line into segments. Quote-aware. Evaluates subshells.
 */
export function splitCommandSegments(command: string): SplitResult {
  const segments: Segment[] = [];
  let parseFailed = false;

  const walk = (input: string, depth: number): void => {
    if (depth > MAX_SUBSTITUTION_DEPTH) {
      parseFailed = true;
      return;
    }
    let current = '';
    let scrubbed = '';
    let writesFile = false;
    let quote: '"' | "'" | null = null;
    let index = 0;

    const flush = (): void => {
      const text = current.trim();
      if (text) segments.push({ text, scrubbed: scrubbed.trim(), writesFile });
      current = '';
      scrubbed = '';
      writesFile = false;
    };

    while (index < input.length) {
      const char = input[index]!;
      const next = input[index + 1];

      if (quote) {
        // Handle quotes/subshells.
        if (quote === "'") {
          current += char;
          if (char === "'") {
            quote = null;
            scrubbed += QUOTED_ARG;
          }
          index += 1;
          continue;
        }
        if (char === '\\' && next !== undefined) {
          current += char + next;
          index += 2;
          continue;
        }
        if (char === '"') {
          current += char;
          quote = null;
          scrubbed += QUOTED_ARG;
          index += 1;
          continue;
        }
        if (char === '$' && next === '(') {
          const end = matchClosing(input, index + 1, '(', ')');
          if (end === -1) {
            parseFailed = true;
            return;
          }
          walk(input.slice(index + 2, end), depth + 1);
          index = end + 1;
          continue;
        }
        if (char === '`') {
          const end = input.indexOf('`', index + 1);
          if (end === -1) {
            parseFailed = true;
            return;
          }
          walk(input.slice(index + 1, end), depth + 1);
          index = end + 1;
          continue;
        }
        current += char;
        index += 1;
        continue;
      }

      if (char === '\\' && next !== undefined) {
        current += next;
        scrubbed += next;
        index += 2;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        current += char;
        index += 1;
        continue;
      }
      if (char === '$' && next === '(') {
        const end = matchClosing(input, index + 1, '(', ')');
        if (end === -1) {
          parseFailed = true;
          return;
        }
        walk(input.slice(index + 2, end), depth + 1);
        index = end + 1;
        continue;
      }
      if (char === '`') {
        const end = input.indexOf('`', index + 1);
        if (end === -1) {
          parseFailed = true;
          return;
        }
        walk(input.slice(index + 1, end), depth + 1);
        index = end + 1;
        continue;
      }
      // Separators end current command.
      if (char === ';' || char === '\n' || char === '\r') {
        flush();
        index += 1;
        continue;
      }
      if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
        flush();
        index += 2;
        continue;
      }
      if (char === '&' || char === '|') {
        flush();
        index += 1;
        continue;
      }
      // Redirection writes files (`>`, `>>`). Ignore fd-to-fd (`2>&1`).
      if (char === '>' || char === '<') {
        index += 1;
        if (input[index] === '&') {
          index += 1;
          while (index < input.length && /\d/.test(input[index]!)) index += 1;
          continue;
        }
        if (char === '>') writesFile = true;
        if (input[index] === '>') index += 1;
        // Consume the redirection target.
        while (index < input.length && /\s/.test(input[index]!)) index += 1;
        while (
          index < input.length &&
          !/[\s;&|<>\r\n]/.test(input[index]!)
        ) index += 1;
        continue;
      }
      current += char;
      scrubbed += char;
      index += 1;
    }

    if (quote) parseFailed = true;
    flush();
  };

  walk(command, 0);
  if (segments.length > MAX_SEGMENTS) parseFailed = true;
  return { segments: segments.slice(0, MAX_SEGMENTS), parseFailed };
}

/** Matching closing bracket index. */
function matchClosing(input: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let index = open; index < input.length; index += 1) {
    const char = input[index];
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// Unwraps `sh -c` payload.
const SHELL_WRAPPER = /^(?:[a-z0-9/_.-]*\/)?(?:ba|z|da|a|k|c)?sh\s+(?:-[a-z]*\s+)*-[a-z]*c\s+(.*)$/is;
// Wrapper builtins (`command`, `builtin`).
const SHELL_EVALUATOR = /^(?:(?:command|builtin)(?:\s+--)?\s+)*(?:(?:eval|source)(?:\s|$)|\.\s+)/i;

function unwrapShellC(text: string): string | null {
  const match = SHELL_WRAPPER.exec(text.trim());
  if (!match?.[1]) return null;
  const inner = match[1].trim();
  const first = inner[0];
  if ((first === '"' || first === "'") && inner.endsWith(first) && inner.length > 1) {
    return inner.slice(1, -1);
  }
  return inner;
}

function decide(
  classification: CommandClass,
  allowed: boolean,
  approvalRequired: boolean,
  reason: string
): ShellDecision {
  return { classification, allowed, approvalRequired, reason };
}

const GIT_GLOBAL_OPTIONS_WITH_ARGUMENT = new Set([
  '-C',
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix'
]);

function commandName(token: string | undefined): string {
  const value = shellTokenValue(token);
  return value.split('/').pop()?.toLowerCase() ?? '';
}

function shellTokenValue(token: string | undefined): string {
  const value = token ?? '';
  const quote = value[0];
  return value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)
    ? value.slice(1, -1)
    : value;
}

/** Recognizes raw git subcommands. */
function isRawGitSubcommand(command: string, subcommand: string): boolean {
  const tokens = command.trim().split(/\s+/u).filter(Boolean);
  let index = 0;

  // Handle POSIX variable assignments.
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(shellTokenValue(tokens[index]))) index += 1;

  for (let wrappers = 0; wrappers < 4; wrappers += 1) {
    const wrapper = commandName(tokens[index]);
    if (wrapper === 'env') {
      index += 1;
      while (index < tokens.length) {
        const token = shellTokenValue(tokens[index]);
        if (token === '--') {
          index += 1;
          break;
        }
        if (token === '-u' || token === '--unset' || token === '-S' || token === '--split-string' || token === '-C' || token === '--chdir' || token === '--argv0') {
          index += 2;
          continue;
        }
        if (token.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (wrapper === 'command' || wrapper === 'exec') {
      index += 1;
      while (tokens[index]?.startsWith('-')) index += 1;
      while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(shellTokenValue(tokens[index]))) index += 1;
      continue;
    }
    break;
  }

  if (commandName(tokens[index]) !== 'git') return false;
  index += 1;
  while (index < tokens.length) {
    const token = shellTokenValue(tokens[index]);
    if (token === subcommand) return true;
    if (!token.startsWith('-')) return false;
    index += GIT_GLOBAL_OPTIONS_WITH_ARGUMENT.has(token) ? 2 : 1;
  }
  return false;
}

function isRawGitPush(command: string): boolean {
  return isRawGitSubcommand(command, 'push');
}

function isRawGitCommit(command: string): boolean {
  return isRawGitSubcommand(command, 'commit');
}

function isRawGitAdd(command: string): boolean {
  return isRawGitSubcommand(command, 'add');
}

function rawGitPushDecision(): ShellDecision {
  return decide(
    'prohibited',
    false,
    false,
    'Raw git push bypasses Forge\'s guarded, verified GitHub write path. Use forge_edit to commit file changes and forge_merge to merge the pull request; Forge performs the required remote writes.'
  );
}

function rawGitLocalWriteDecision(kind: 'commit' | 'add'): ShellDecision {
  return decide(
    'prohibited',
    false,
    false,
    `Raw git ${kind} only mutates the ephemeral executor checkout. Call forge_files_read on the paths you changed, then forge_edit (it returns commit_url on GitHub). Do not claim work is saved until forge_edit succeeds.`
  );
}

function repoFileWriteDecision(): ShellDecision {
  return decide(
    'prohibited',
    false,
    false,
    'Shell must not write repository files. Call forge_files_read, then forge_edit (commit_url). Redirects, sed -i, and tee only mutate the ephemeral executor.'
  );
}

/** Classifies command segment. */
function classifySegment(segment: Segment, networkPolicy: NetworkPolicyMode, depth: number): ShellDecision {
  const raw = segment.text.trim();
  // Run patterns against scrubbed form.
  const trimmed = segment.scrubbed.trim() || raw;
  if (!raw) return decide('read_only', true, false, 'Empty segment.');

  // Evaluate unwrapped `sh -c` payloads via raw text.
  if (depth < MAX_SUBSTITUTION_DEPTH) {
    const inner = unwrapShellC(raw);
    if (inner !== null && inner !== raw) {
      const split = splitCommandSegments(inner);
      if (split.parseFailed) {
        return decide('requires_approval', true, true, 'Wrapped shell command could not be parsed; requires explicit approval.');
      }
      return worstOf(split.segments.map((part) => classifySegment(part, networkPolicy, depth + 1)));
    }
  }

  if (isRawGitPush(raw) || isRawGitPush(trimmed)) return rawGitPushDecision();
  if (isRawGitCommit(raw) || isRawGitCommit(trimmed)) return rawGitLocalWriteDecision('commit');
  if (isRawGitAdd(raw) || isRawGitAdd(trimmed)) return rawGitLocalWriteDecision('add');

  // Escalate evaluation builtins. Requires human approval.
  if (SHELL_EVALUATOR.test(trimmed)) {
    return decide(
      'shell_evaluation',
      true,
      true,
      'Shell evaluation executes an additional command program and requires explicit approval.'
    );
  }

  if (prohibited.some((rule) => rule.test(trimmed))) {
    return decide('prohibited', false, false, 'Command requests prohibited privileges or network access.');
  }
  if (destructive.some((rule) => rule.test(trimmed))) {
    return decide('destructive', false, true, 'Destructive command requires an approved capability.');
  }
  if (installs.some((rule) => rule.test(trimmed))) {
    return decide(
      'dependency_install',
      networkPolicy !== 'deny_all',
      true,
      'Dependency installation executes repository and package lifecycle scripts.'
    );
  }
  if (isExternalWranglerCommand(trimmed)) {
    return decide(
      'external_side_effect',
      ['development', 'custom_allowlist', 'unrestricted_with_approval'].includes(networkPolicy),
      true,
      'Wrangler deploy/publish/delete reaches a live Cloudflare account and requires approval. Use forge_deploy with an attached API token (map_env if your key is not CLOUDFLARE_API_TOKEN). CLOUDFLARE_ACCOUNT_ID is optional but pins the account when present.'
    );
  }
  if (network.some((rule) => rule.test(trimmed))) {
    return decide(
      'network_access',
      ['development', 'custom_allowlist', 'unrestricted_with_approval'].includes(networkPolicy),
      networkPolicy === 'unrestricted_with_approval',
      'Command accesses the network.'
    );
  }
  // Handle `sed` mutation.
  if (SED.test(trimmed)) {
    if (SED_IN_PLACE.test(trimmed) || segment.writesFile) return repoFileWriteDecision();
    return decide('read_only', true, false, 'Read-only stream filter.');
  }
  // Prevent direct file writes via redirect/tee.
  if (segment.writesFile || /\btee\b/i.test(trimmed) || /\bperl\b[^\n]*\s-i\b/i.test(trimmed)) {
    return repoFileWriteDecision();
  }
  if (readOnly.some((rule) => rule.test(trimmed))) {
    return decide('read_only', true, false, 'Read-only workspace command.');
  }
  return decide('local_mutation', true, false, 'Command is confined to the isolated workspace.');
}

/** Worst segment determines classification. */
function worstOf(decisions: ShellDecision[]): ShellDecision {
  if (decisions.length === 0) return decide('read_only', true, false, 'Nothing to run.');
  let worst = decisions[0]!;
  for (const decision of decisions) {
    if (SEVERITY[decision.classification] > SEVERITY[worst.classification]) worst = decision;
  }
  return decide(
    worst.classification,
    decisions.every((decision) => decision.allowed),
    decisions.some((decision) => decision.approvalRequired),
    decisions.length > 1 ? `${worst.reason} (worst of ${decisions.length} chained commands)` : worst.reason
  );
}

export function classifyCommand(command: string, networkPolicy: NetworkPolicyMode): ShellDecision {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 16_384 || trimmed.includes('\0')) {
    return decide('prohibited', false, false, 'Command is empty, too large, or contains a NUL byte.');
  }
  // Early push check.
  if (isRawGitPush(trimmed)) return rawGitPushDecision();
  const { segments, parseFailed } = splitCommandSegments(trimmed);
  if (parseFailed || segments.length === 0) {
    // Unparseable structure fallback.
    if (prohibited.some((rule) => rule.test(trimmed))) {
      return decide('prohibited', false, false, 'Command requests prohibited privileges or network access.');
    }
    if (destructive.some((rule) => rule.test(trimmed))) {
      return decide('destructive', false, true, 'Destructive command requires an approved capability.');
    }
    return decide(
      'requires_approval',
      true,
      true,
      'Command structure could not be parsed (unbalanced quotes or excessive nesting); requires explicit approval because its effective behavior cannot be classified automatically.'
    );
  }
  return worstOf(segments.map((segment) => classifySegment(segment, networkPolicy, 0)));
}

/**
 * Syntactic approval/network gate. Does not replace sandbox isolation.
 */
export function assertCommandAllowed(command: string, networkPolicy: NetworkPolicyMode, hasApproval: boolean): ShellDecision {
  const decision = classifyCommand(command, networkPolicy);
  if (!decision.allowed) throw new ForgeError({ code: 'FORGE_COMMAND_BLOCKED', message: decision.reason, retryable: false, details: { classification: decision.classification } });
  if (decision.approvalRequired && !hasApproval) throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: decision.reason, retryable: false, details: { classification: decision.classification } });
  return decision;
}

/** Environment defaults for non-interactive CLIs. */
export function nonInteractiveShellEnv(
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    CI: '1',
    npm_config_yes: 'true',
    PNPM_CONFIRM_MODULES_PURGE: 'false',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    GIT_TERMINAL_PROMPT: '0',
    DEBIAN_FRONTEND: 'noninteractive',
    ...extra
  };
}
