/**
 * List Cloudflare accounts reachable with an API token.
 * Runs in the Worker (no sandbox). Never returns the token.
 */

export interface CloudflareAccountSummary {
  id: string;
  name: string;
}

export type CloudflareAccountsResult =
  | { ok: true; accounts: CloudflareAccountSummary[] }
  | { ok: false; status: number; message: string };

interface CloudflareAccountsResponse {
  success?: boolean;
  errors?: Array<{ message?: string; code?: number }>;
  result?: Array<{ id?: string; name?: string }>;
}

export async function listCloudflareAccounts(
  apiToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<CloudflareAccountsResult> {
  const token = apiToken.trim();
  if (!token) {
    return { ok: false, status: 0, message: 'API token is empty.' };
  }
  let response: Response;
  try {
    response = await fetchImpl('https://api.cloudflare.com/client/v4/accounts?per_page=50', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : 'Cloudflare accounts request failed.'
    };
  }
  let body: CloudflareAccountsResponse = {};
  try {
    body = (await response.json()) as CloudflareAccountsResponse;
  } catch {
    body = {};
  }
  if (!response.ok || body.success === false) {
    const detail = body.errors?.map((e) => e.message).filter(Boolean).join('; ');
    return {
      ok: false,
      status: response.status,
      message: detail || `Cloudflare accounts API returned HTTP ${response.status}.`
    };
  }
  const accounts = (body.result ?? [])
    .filter((row): row is { id: string; name: string } => Boolean(row.id && row.name))
    .map((row) => ({ id: row.id, name: row.name }));
  return { ok: true, accounts };
}

/** Pick which vault env name holds the Cloudflare API token. */
export function resolveCloudflareTokenVar(
  varNames: string[],
  tokenVar?: string
): { ok: true; token_var: string } | { ok: false; next_step: string } {
  if (tokenVar) {
    if (!varNames.includes(tokenVar)) {
      return {
        ok: false,
        next_step: `token_var "${tokenVar}" is not on this secret. Available: ${varNames.join(', ') || 'none'}.`
      };
    }
    return { ok: true, token_var: tokenVar };
  }
  if (varNames.includes('CLOUDFLARE_API_TOKEN')) {
    return { ok: true, token_var: 'CLOUDFLARE_API_TOKEN' };
  }
  if (varNames.length === 1 && varNames[0]) {
    return { ok: true, token_var: varNames[0] };
  }
  return {
    ok: false,
    next_step: `Pass token_var naming which env key is the Cloudflare API token. Available: ${varNames.join(', ') || 'none'}.`
  };
}
