export class AuthorizationUnavailableError extends Error {}

/** After signature verification, obtain the account's current server-owned grants.
 * A still-valid token is proof of identity, not proof that an old role is retained. */
export async function currentAuthorization(
  token: string,
  signed: Record<string, unknown>,
  url: string,
  anonKey: string,
  request: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
  if (!url || !anonKey) throw new AuthorizationUnavailableError('Authentication unavailable');
  let response: Response;
  try {
    response = await request(`${url.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new AuthorizationUnavailableError('Authentication unavailable');
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new AuthorizationUnavailableError('Authentication unavailable');
  let user: Record<string, unknown>;
  try {
    user = await response.json();
  } catch {
    throw new AuthorizationUnavailableError('Invalid authentication response');
  }
  if (!user || user.id !== signed.sub || !user.id) return null;
  if (typeof user.banned_until === 'string' && Date.parse(user.banned_until) > Date.now())
    return null;
  return { ...signed, email: user.email, app_metadata: user.app_metadata ?? {} };
}
