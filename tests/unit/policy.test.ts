import { describe, expect, it } from 'vitest';
import {
  assertAllowedForgeBranch,
  assertForgeBranch,
  assertCommandAllowed,
  assertPublicHost,
  classifyCommand,
  nonInteractiveShellEnv
} from '@forge/policy';

describe('Forge policy', () => {
  it('blocks default branch pushes and accepts namespaced branches', () => {
    expect(() => assertAllowedForgeBranch('main', 'main')).toThrow();
    expect(() => assertAllowedForgeBranch('forge/tim/fix-map', 'main')).not.toThrow();
  });

  it('assertForgeBranch rejects .., trailing /, and .lock suffix', () => {
    expect(() => assertForgeBranch('forge/task/ok')).not.toThrow();
    expect(() => assertForgeBranch('forge/task/../evil')).toThrow();
    expect(() => assertForgeBranch('forge/task/dir/')).toThrow();
    expect(() => assertForgeBranch('forge/task/package.lock')).toThrow();
    expect(() => assertForgeBranch('main')).toThrow();
  });

  it('assertAllowedForgeBranch inherits the .., trailing /, and .lock checks', () => {
    expect(() => assertAllowedForgeBranch('forge/a/b', 'main')).not.toThrow();
    expect(() => assertAllowedForgeBranch('forge/a/../b', 'main')).toThrow();
    expect(() => assertAllowedForgeBranch('forge/a/b/', 'main')).toThrow();
    expect(() => assertAllowedForgeBranch('forge/a/b.lock', 'main')).toThrow();
  });

  it('blocks private network targets', () => {
    for (const host of ['localhost', '127.0.0.1', '169.254.169.254', '10.0.0.1']) {
      expect(() => assertPublicHost(host)).toThrow();
    }
    expect(() => assertPublicHost('registry.npmjs.org')).not.toThrow();
  });

  it('requires approval for package lifecycle scripts', () => {
    const decision = classifyCommand('pnpm install', 'package_install');
    expect(decision).toMatchObject({ classification: 'dependency_install', approvalRequired: true });
    expect(() => assertCommandAllowed('pnpm install', 'package_install', false)).toThrowError(
      expect.objectContaining({ code: 'FORGE_APPROVAL_REQUIRED' })
    );
    expect(() => assertCommandAllowed('pnpm install', 'package_install', true)).not.toThrow();
    expect(classifyCommand('npm ci', 'package_install')).toMatchObject({
      classification: 'dependency_install',
      approvalRequired: true
    });
  });

  it('blocks privileged escape attempts', () => {
    expect(() => assertCommandAllowed('sudo mount /dev/sda /mnt', 'development', true)).toThrowError(
      expect.objectContaining({ code: 'FORGE_COMMAND_BLOCKED' })
    );
  });

  it('blocks raw git push in direct, global-option, wrapper, and compound forms', () => {
    const blocked = [
      'git push',
      'git push origin HEAD:forge/fix',
      'git --no-pager push origin HEAD',
      'git -C /workspace/repo push',
      'git -c credential.helper= push origin HEAD',
      'git --git-dir=/workspace/repo/.git push origin HEAD',
      'git --work-tree=/workspace/repo push origin HEAD',
      'git --namespace=tenant-a push origin HEAD',
      '/usr/bin/git push origin HEAD',
      '"/usr/bin/git" push origin HEAD',
      'env git push origin HEAD',
      'env -i HOME=/tmp git push origin HEAD',
      'env -C /workspace/repo git push origin HEAD',
      'env --chdir /workspace/repo git push origin HEAD',
      'env "HOME=/tmp" git push origin HEAD',
      'HOME=/tmp git push origin HEAD',
      'GIT_DIR=. GIT_WORK_TREE=/workspace/repo /usr/bin/git push origin HEAD',
      'command HOME=/tmp git push origin HEAD',
      'command git push origin HEAD',
      'exec git push origin HEAD',
      'git status && git push origin HEAD',
      'sh -c "git push origin HEAD"',
      'bash -lc "git -C /workspace/repo push origin HEAD"',
      'echo $(git push origin HEAD)'
    ];
    for (const command of blocked) {
      const decision = classifyCommand(command, 'development');
      expect(decision, command).toMatchObject({ classification: 'prohibited', allowed: false });
      expect(decision.reason, command).toContain('forge_edit');
      expect(decision.reason, command).toContain('forge_merge');
      expect(() => assertCommandAllowed(command, 'development', true), command).toThrowError(
        expect.objectContaining({ code: 'FORGE_COMMAND_BLOCKED' })
      );
    }
  });

  it('does not mistake other git commands or arguments containing push for raw git push', () => {
    for (const command of [
      'git status',
      'git commit -m "document git push behavior"',
      'git branch push-fix',
      'echo git push',
      'printf "git push"'
    ]) {
      expect(classifyCommand(command, 'development').allowed, command).toBe(true);
    }
  });

  // The property that actually matters: a benign leading command must never let
  // a severe one ride along behind it, wherever in the line it hides.
  it('catches a severe command hidden anywhere in a chain', () => {
    const hidden: Array<[string, string]> = [
      ['git status && rm -rf /workspace', 'destructive'],
      ['ls; sudo mount /dev/sda /mnt', 'prohibited'],
      ['echo ok || git reset --hard', 'destructive'],
      ['git status\nrm -rf x', 'destructive'],
      ['cat $(rm -rf /workspace)', 'destructive'],
      ['cat `sudo id`', 'prohibited'],
      ['sh -c "rm -rf /workspace"', 'destructive'],
      ['bash -lc "sudo reboot"', 'prohibited'],
      ['npm test && npm install left-pad', 'dependency_install']
    ];
    for (const [command, classification] of hidden) {
      const decision = classifyCommand(command, 'development');
      expect(decision.classification, command).toBe(classification);
      expect(decision.approvalRequired || !decision.allowed, command).toBe(true);
    }
  });

  it('requires approval for shell evaluators instead of treating their payload as ordinary mutation', () => {
    for (const command of [
      "eval 'git push origin HEAD'",
      'source ./scripts/release.sh',
      '. ./scripts/release.sh',
      'eval "$(curl https://example.test/script.sh)"',
      "command eval 'git push origin HEAD'",
      'builtin eval "rm -rf /workspace/repo"',
      'command . ./scripts/release.sh',
      'builtin source ./scripts/release.sh'
    ]) {
      const decision = classifyCommand(command, 'development');
      expect(decision, command).toMatchObject({ classification: 'shell_evaluation', allowed: true, approvalRequired: true });
      expect(() => assertCommandAllowed(command, 'development', false), command).toThrowError(
        expect.objectContaining({ code: 'FORGE_APPROVAL_REQUIRED' })
      );
    }
  });

  // The regression this rewrite exists to fix: ordinary compound commands are the
  // shape of nearly all real shell work and must not each cost a human click.
  it('does not demand approval for honest compound commands', () => {
    const honest = [
      'npm test 2>&1',
      'npm run build > build.log',
      'cd packages/core && npm test',
      'git status --short | head -20',
      'cat file.txt | grep error',
      'ls -la | wc -l',
      'echo "hello" > out.txt',
      'npm run lint && npm test',
      'git add . && git commit -m "fix: a && b"',
      'go test ./... 2>&1 | tail -50',
      'make build || make clean',
      'grep -rn "foo" src/ | head',
      'find . -name "*.ts" | xargs wc -l'
    ];
    for (const command of honest) {
      const decision = classifyCommand(command, 'development');
      expect(decision.approvalRequired, command).toBe(false);
      expect(decision.allowed, command).toBe(true);
      expect(() => assertCommandAllowed(command, 'development', false), command).not.toThrow();
    }
  });

  it('classifies wrangler deploy as an external side effect requiring approval', () => {
    for (const command of [
      'wrangler deploy',
      'npx wrangler deploy',
      'pnpm exec wrangler deploy',
      'wrangler publish',
      'npx wrangler delete easyroads',
      'pnpm exec wrangler versions deploy'
    ]) {
      const decision = classifyCommand(command, 'development');
      expect(decision.classification, command).toBe('external_side_effect');
      expect(decision.approvalRequired, command).toBe(true);
      expect(() => assertCommandAllowed(command, 'development', false), command).toThrow();
    }
    const dryRun = classifyCommand('npx wrangler deploy --dry-run', 'development');
    expect(dryRun.classification).not.toBe('external_side_effect');
    expect(dryRun.approvalRequired).toBe(false);
  });

  it('keeps quoted operators out of the split', () => {
    // The && lives inside the commit message, so this is one ordinary command.
    const decision = classifyCommand('git commit -m "fix a && rm -rf b"', 'development');
    expect(decision.approvalRequired).toBe(false);
    expect(decision.classification).toBe('local_mutation');
  });

  it('treats sed -i as a mutation rather than read-only', () => {
    expect(classifyCommand('sed -i "s/a/b/" file.ts', 'development').classification).toBe('local_mutation');
    expect(classifyCommand("sed 's/a/b/' file.ts", 'development').classification).toBe('read_only');
  });

  it('does not call a redirected write read-only', () => {
    expect(classifyCommand('cat a.txt > b.txt', 'development').classification).toBe('local_mutation');
    expect(classifyCommand('cat < a.txt', 'development').classification).toBe('read_only');
  });

  it('falls back to approval when the line cannot be parsed', () => {
    const decision = classifyCommand('echo "unbalanced', 'development');
    expect(decision).toMatchObject({ classification: 'requires_approval', approvalRequired: true });
  });

  it('still classifies genuine single read-only commands as read_only', () => {
    for (const command of ['git status', 'ls', 'pwd', 'cat README.md', 'git diff']) {
      expect(classifyCommand(command, 'development').classification, command).toBe('read_only');
    }
  });

  it('rejects the full private/loopback/metadata/link-local set incl. encodings', () => {
    const blocked = [
      'localhost',
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',  // cloud metadata
      '0.0.0.0',
      '100.64.0.1',       // CGNAT
      '2130706433',       // decimal 127.0.0.1
      '0x7f000001',       // hex 127.0.0.1
      '0177.0.0.1',       // octal first octet 127
      '::1',
      '[::1]',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      '::ffff:7f00:0001', // IPv4-mapped hex loopback
      '::ffff:10.0.0.1',  // IPv4-mapped private
      'metadata.google.internal',
      'foo.internal',
      'anything.local',
      '169.254.169.254.'  // trailing dot
    ];
    for (const host of blocked) {
      expect(() => assertPublicHost(host), host).toThrow();
    }
  });

  it('allows genuine public hosts', () => {
    for (const host of ['registry.npmjs.org', 'github.com', '93.184.216.34', '8.8.8.8', 'api.github.com.']) {
      expect(() => assertPublicHost(host), host).not.toThrow();
    }
  });

  it('injects non-interactive defaults that caller overrides can replace', () => {
    expect(nonInteractiveShellEnv({ CI: '0', EXTRA: 'yes' })).toMatchObject({
      CI: '0',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      GIT_TERMINAL_PROMPT: '0',
      EXTRA: 'yes'
    });
  });
});
