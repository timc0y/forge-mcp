import { describe, expect, it } from 'vitest';
import {
  assertAllowedForgeBranch,
  assertCommandAllowed,
  assertPublicHost,
  classifyCommand
} from '@forge/policy';

describe('Forge policy', () => {
  it('blocks default branch pushes and accepts namespaced branches', () => {
    expect(() => assertAllowedForgeBranch('main', 'main')).toThrow();
    expect(() => assertAllowedForgeBranch('forge/tim/fix-map', 'main')).not.toThrow();
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
  });

  it('blocks privileged escape attempts', () => {
    expect(() => assertCommandAllowed('sudo mount /dev/sda /mnt', 'development', true)).toThrowError(
      expect.objectContaining({ code: 'FORGE_COMMAND_BLOCKED' })
    );
  });

  it('never classifies chained/obfuscated commands as low-risk', () => {
    const chains = [
      'git status && cat /etc/passwd',
      'ls; python -c "import os"',
      'git status || whoami',
      'echo hi | base64',
      'echo hi & sleep 1',
      'cat `whoami`',
      'cat $(whoami)',
      'echo ${SECRET}',
      'cat foo > /tmp/out',
      'cat < /etc/passwd',
      'sh -c "cat /etc/passwd"',
      'bash -lc "id"',
      'git status\nrm -rf x'
    ];
    for (const command of chains) {
      const decision = classifyCommand(command, 'development');
      expect(decision.classification, command).not.toBe('read_only');
      expect(decision.classification, command).not.toBe('local_mutation');
      // Anything not caught by a stronger (prohibited/destructive/network)
      // rule lands in requires_approval and is never auto-approved.
      expect(decision.approvalRequired, command).toBe(true);
    }
  });

  it('requires approval (not auto-approve) for a benign-prefixed chain', () => {
    const decision = classifyCommand('git status && cat secrets', 'development');
    expect(decision).toMatchObject({ classification: 'requires_approval', approvalRequired: true });
    expect(() => assertCommandAllowed('git status && cat secrets', 'development', false)).toThrowError(
      expect.objectContaining({ code: 'FORGE_APPROVAL_REQUIRED' })
    );
    expect(() => assertCommandAllowed('git status && cat secrets', 'development', true)).not.toThrow();
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
});
