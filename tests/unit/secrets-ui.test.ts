import { describe, expect, it } from 'vitest';
import { parseEnvText } from '../../apps/forge-edge-gateway/src/secrets-ui';

describe('secrets-ui parseEnvText', () => {
  it('parses valid KEY=value lines and ignores comments and whitespace', () => {
    const input = `
# Comment line
  CLOUDFLARE_API_TOKEN=supersecret123
  
  DATABASE_URL=postgres://user:pass@host/db  
`;
    const result = parseEnvText(input);
    expect(result).toEqual({
      CLOUDFLARE_API_TOKEN: 'supersecret123',
      DATABASE_URL: 'postgres://user:pass@host/db'
    });
  });

  it('preserves equal signs in secret values', () => {
    const input = 'SECRET_KEY=abc=def==123';
    const result = parseEnvText(input);
    expect(result).toEqual({
      SECRET_KEY: 'abc=def==123'
    });
  });

  it('rejects input with no KEY=value lines', () => {
    expect(() => parseEnvText('')).toThrow('Add at least one');
    expect(() => parseEnvText('# Only comments\n\n')).toThrow('Add at least one');
  });

  it('rejects lines without an equals sign or missing key', () => {
    expect(() => parseEnvText('NOEQUALS')).toThrow('Invalid line');
    expect(() => parseEnvText('=NOKEY')).toThrow('Invalid line');
  });

  it('rejects invalid environment variable names', () => {
    expect(() => parseEnvText('123BAD=val')).toThrow('Invalid environment variable name');
    expect(() => parseEnvText('INVALID-KEY=val')).toThrow('Invalid environment variable name');
  });
});
