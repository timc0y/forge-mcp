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
// HOW THIS CLASSIFIES (segment-aware, worst-segment-wins)
//   A real command line is split into its constituent commands — on `;`, `&&`,
//   `||`, `|`, `&`, newlines, and redirection — with quoting respected, and each
//   segment is classified on its own. Command substitutions (`$(...)`, backticks)
//   are pulled out and classified as segments too, and `sh -c "..."` is unwrapped
//   so the inner command is what gets judged. The command's overall class is the
//   worst class among its segments; it is blocked if any segment is blocked and
//   needs approval if any segment needs approval.
//
//   This replaces an earlier design that escalated EVERY command containing a
//   shell control operator to `requires_approval`. That rule made `ls | wc -l`
//   and `cd pkg && npm test` — the shape of most real commands — demand a human
//   click, while `python -c '...'` and `bash script.sh` sailed through with none,
//   so its friction was inversely correlated with its risk. Splitting and judging
//   each segment keeps the property that actually mattered (a benign prefix like
//   `git status &&` cannot hide an `rm -rf` behind it) without taxing every
//   honest pipeline.
//
// GUARANTEES THIS MODULE PROVIDES:
//   - A command that syntactically matches a prohibited/destructive/install/
//     network pattern *in any segment* is escalated out of the auto-approve path,
//     including when that segment is hidden behind a benign leading command or
//     inside a command substitution.
//   - A command whose structure cannot be parsed (unbalanced quotes, absurd
//     segment counts) is never classified low-risk; it falls back to
//     `requires_approval`.
//
// GUARANTEES IT DOES NOT PROVIDE:
//   - It does not prevent execution of a malicious command. Real isolation comes
//     from the sandbox container (non-root, dropped capabilities, no host mounts)
//     and the network egress policy enforced at connect/resolve time.
//   - It does not interpret non-shell code. `python -c`, `node -e` and friends
//     are classified as ordinary workspace mutation: their payload is not shell,
//     so there is nothing honest to pattern-match, and the sandbox is what bounds
//     them. Pretending otherwise would only add friction, not safety.
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
  // Fallback bucket for commands whose structure could not be parsed well enough
  // to classify segment-by-segment (unbalanced quotes, pathological nesting).
  // Allowed to run, but never auto-approved.
  | 'requires_approval';

// Worst-wins ordering. Higher number = more severe; the overall classification of
// a multi-segment command is the segment with the highest rank.
const SEVERITY: Record<CommandClass, number> = {
  read_only: 0,
  local_mutation: 1,
  network_access: 2,
  external_side_effect: 3,
  dependency_install: 4,
  requires_approval: 5,
  destructive: 6,
  privileged: 7,
  prohibited: 8
};

// Retained for callers that want a cheap "is this a compound command" probe.
// NOTE: this is no longer what drives approval — see classifyCommand.
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

// Publish / destroy / rollback against a live cloud account. Dry-runs stay local.
// Matches bare `wrangler deploy` and wrappers (`npx wrangler deploy`, `pnpm exec wrangler …`).
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

// Commands that only read. `sed` is deliberately absent: `sed -i` edits in place,
// and the previous rule classified it read_only, which was simply wrong. It is
// handled below so the non-`-i` form still reads as read-only.
const readOnly = [
  /^(pwd|ls|ll|find|rg|grep|egrep|fgrep|cat|bat|head|tail|wc|sort|uniq|cut|tr|basename|dirname|stat|file|du|df|tree|which|type|echo|printf|true|false|date|whoami|id|env|printenv|realpath|readlink|diff|cmp|md5sum|sha256sum)(\s|$)/i,
  /^git\s+(status|diff|log|show|branch|remote|config\s+--get|rev-parse|describe|blame|ls-files|ls-tree|cat-file|shortlog|tag\s*$)(\s|$)/i,
  /^(node|python3?|ruby|perl)\s+--version(\s|$)/i,
  /^(npm|pnpm|yarn|bun|cargo|go|deno)\s+(--version|-v|list|ls|why|outdated|view|info)(\s|$)/i
];

// `sed` without `-i`/`--in-place` is a read-only stream filter; with it, it is an
// in-place file mutation.
const SED_IN_PLACE = /^sed\s+[^\n]*(-i(\b|[a-z0-9.]*)|--in-place)/i;
const SED = /^sed(\s|$)/i;

export interface ShellDecision {
  classification: CommandClass;
  allowed: boolean;
  approvalRequired: boolean;
  reason: string;
}

interface Segment {
  /** Raw command text, quotes intact, with substitutions and redirections removed. */
  text: string;
  /**
   * Same segment with every quoted literal replaced by a placeholder. Quoted text
   * is *data* — a filename, a commit message — not a command, so classification
   * patterns run against this form. Without it, `git commit -m "fix a && rm -rf b"`
   * matches the destructive `rm -rf` rule on the contents of its own message.
   */
  scrubbed: string;
  /** True when this segment redirects output into a file (`>`, `>>`). */
  writesFile: boolean;
}

/** Stands in for a quoted literal in `Segment.scrubbed`. */
const QUOTED_ARG = 'ARG';

interface SplitResult {
  segments: Segment[];
  /** True when the line could not be parsed confidently (unbalanced quotes etc.). */
  parseFailed: boolean;
}

const MAX_SEGMENTS = 64;
const MAX_SUBSTITUTION_DEPTH = 8;

/**
 * Split a shell line into the individual commands it runs.
 *
 * Quote-aware: operators inside '...' or "..." are literal text, not separators,
 * so `git commit -m "fix a && b"` stays one segment. Command substitutions
 * (`$(...)` and backticks) are lifted out and returned as their own segments so
 * the command hiding inside them is classified too. Redirection operators end a
 * segment (the following filename is data, not a command) and mark it as writing.
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
        // Inside single quotes nothing expands. Inside double quotes, $( ) and
        // backticks still run, so keep looking for them.
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
      // Separators: ; && || | & and newlines all end the current command.
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
      // Redirection: the rest up to the next separator is a target filename, not
      // a command. `>`/`>>` mean this segment writes a file.
      if (char === '>' || char === '<') {
        if (char === '>') writesFile = true;
        index += 1;
        if (input[index] === '>' || input[index] === '&') index += 1;
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

/** Index of the closing bracket matching the opener at `open`, or -1. */
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

// `sh -c "…"` / `bash -lc '…'` wraps a real shell command. Unwrap it so the inner
// command is what gets classified rather than the harmless-looking wrapper.
const SHELL_WRAPPER = /^(?:[a-z0-9/_.-]*\/)?(?:ba|z|da|a|k|c)?sh\s+(?:-[a-z]*\s+)*-[a-z]*c\s+(.*)$/is;

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

/** Classify one already-split command segment. */
function classifySegment(segment: Segment, networkPolicy: NetworkPolicyMode, depth: number): ShellDecision {
  const raw = segment.text.trim();
  // Classification patterns run against the scrubbed form so a quoted argument
  // (a commit message, a filename) can never masquerade as a command.
  const trimmed = segment.scrubbed.trim() || raw;
  if (!raw) return decide('read_only', true, false, 'Empty segment.');

  // A wrapped `sh -c "…"` is judged by what it actually runs, so this one reads
  // the raw text — the quoted payload there really is a command.
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
      'Wrangler deploy/publish/delete reaches a live Cloudflare account and requires approval. Use forge_cloudflare_deploy with an attached Cloudflare secret (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID) so the account is pinned and the URL is verified.'
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
  // `sed -i` mutates in place; plain `sed` is a read-only filter.
  if (SED.test(trimmed)) {
    return SED_IN_PLACE.test(trimmed)
      ? decide('local_mutation', true, false, 'In-place stream edit confined to the isolated workspace.')
      : decide(segment.writesFile ? 'local_mutation' : 'read_only', true, false, 'Read-only stream filter.');
  }
  if (!segment.writesFile && readOnly.some((rule) => rule.test(trimmed))) {
    return decide('read_only', true, false, 'Read-only workspace command.');
  }
  return decide('local_mutation', true, false, 'Command is confined to the isolated workspace.');
}

/**
 * Merge segment decisions: the worst classification wins, the command is blocked
 * if any segment is blocked, and approval is required if any segment requires it.
 */
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
  const { segments, parseFailed } = splitCommandSegments(trimmed);
  if (parseFailed || segments.length === 0) {
    // Structure we could not read confidently. Fall back to the old behaviour —
    // allowed to run, but never without a human — rather than guessing low-risk.
    // The severe whole-string patterns still get a chance to block outright.
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

/**
 * Environment defaults that keep package managers and CLIs non-interactive.
 * ChatGPT/tool hosts cannot answer Corepack, pnpm, or login prompts inside a
 * foreground command, so Forge always injects these and lets caller overrides win.
 */
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
