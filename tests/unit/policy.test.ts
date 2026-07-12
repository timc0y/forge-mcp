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
});
