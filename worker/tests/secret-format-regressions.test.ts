import { describe, expect, it } from 'vitest';
import { author } from '../src/authoring';
import { containsHighSeveritySecret } from '../src/content-safety';
import type { ToolContext } from '../src/tool-types';
import type { Env } from '../src/env';

describe('private key protection', () => {
  it.each(['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY'])('rejects %s before any GitHub request', async (format) => {
    const content = `-----BEGIN ${format}-----\nSYNTHETIC_NOT_A_REAL_KEY\n-----END ${format}-----`;
    const calls: string[] = [];
    const request: ToolContext['gh'] = async (path) => { calls.push(path); throw new Error('Must not contact GitHub'); };
    const ctx: ToolContext = { env: {} as Env, identity: { userId: 'u', githubLogin: 'o' }, track: () => {}, gh: request, ghUser: request };
    await expect(author(ctx, { repo: 'o/r', message: 'Save file', files: [{ path: 'key.pem', content }] })).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
    expect(calls).toEqual([]);
  });

  it('allows public keys and prose about private keys', () => {
    expect(containsHighSeveritySecret('-----BEGIN PUBLIC KEY-----\nSYNTHETIC\n-----END PUBLIC KEY-----')).toBe(false);
    expect(containsHighSeveritySecret('Never commit a PRIVATE KEY.')).toBe(false);
  });
});
