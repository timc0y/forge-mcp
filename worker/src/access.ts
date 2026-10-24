import type { Env } from './env';

/** Invalid or incomplete configuration grants no access, including in development. */
export function allowedLogins(env: Pick<Env, 'FORGE_ALLOWED_LOGINS'>): string[] {
  const value = env.FORGE_ALLOWED_LOGINS;
  if (typeof value !== 'string' || !value.trim()) return [];
  const logins = value.split(',').map(login => login.trim());
  if (logins.some(login => login.length > 39 || !/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(login))) return [];
  return logins.map(login => login.toLowerCase());
}

export function isLoginAllowed(env: Pick<Env, 'FORGE_ALLOWED_LOGINS'>, login: string): boolean {
  return typeof login === 'string' && allowedLogins(env).includes(login.toLowerCase());
}
