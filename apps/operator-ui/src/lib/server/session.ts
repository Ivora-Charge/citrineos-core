// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side session: who is calling a server action or route handler.
 *
 * The session is the Supabase session in the shared SSO cookie
 * (@lib/utils/auth-cookie). Reading it here:
 *
 *  1. @supabase/ssr reassembles the cookie and, if the access token has
 *     expired, refreshes it with the rotating refresh token and writes the
 *     new pair back (server actions and route handlers may set cookies);
 *  2. the access token's signature is verified against the project's JWKS
 *     (ES256) -- the cookie is client-writable, so nothing in it is trusted
 *     until this passes;
 *  3. the CSMS claims for this environment must validate
 *     (@lib/utils/csms-claims) and billing must not be blocked
 *     (@lib/utils/billing-claims).
 *
 * Anything short of that is "no session". The generic dev provider (never in
 * production, see config.ts) yields its static admin.
 */

import { createServerClient } from '@supabase/ssr';
import { cookies, headers } from 'next/headers';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import config from '@lib/utils/config';
import { authCookieOptions } from '@lib/utils/auth-cookie';
import { readCsmsClaims, hasFleetAccess } from '@lib/utils/csms-claims';
import { currentAuthorization, AuthorizationUnavailableError } from '@lib/utils/live-authorization';
import { readBillingBlock } from '@lib/utils/billing-claims';

export interface CsmsSession {
  accessToken: string;
  user: {
    id: string;
    email?: string;
    name?: string;
    roles: string[];
    /** Tenant bound to the token. Always set for tenant users; platform staff
     * may or may not have a home tenant (see @lib/utils/csms-claims). */
    tenantId?: string;
  };
}

export class AuthUnavailableError extends Error {
  override name = 'AuthUnavailableError' as const;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** Verify a Supabase access token offline against the project JWKS. Throws
 * on a bad token; throws AuthUnavailableError when the key set could not be
 * fetched (callers decide whether that fails open or closed). */
export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  if (!config.supabaseUrl) throw new AuthUnavailableError('NEXT_PUBLIC_SUPABASE_URL is not set');
  const issuer = `${config.supabaseUrl}/auth/v1`;
  jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated' });
    return payload;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    // fetch() failures surface as TypeError from the JWKS loader; a timeout
    // has its own code. Everything else means the token itself is bad.
    if (code === 'ERR_JWKS_TIMEOUT' || err instanceof TypeError) {
      throw new AuthUnavailableError(String(err));
    }
    throw err;
  }
}

/** Build the session object from a verified token payload, or null when the
 * holder has no access to this environment. */
export function sessionFromPayload(token: string, payload: JWTPayload): CsmsSession | null {
  const csms = readCsmsClaims(payload, config.csmsEnv);
  if (!csms || !hasFleetAccess(csms)) return null;
  if (readBillingBlock(payload)) return null;
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  return {
    accessToken: token,
    user: {
      id: String(payload.sub ?? ''),
      email,
      name: email,
      roles: csms.roles,
      ...(csms.tenantId ? { tenantId: csms.tenantId } : {}),
    },
  };
}

export async function getCsmsSession(): Promise<CsmsSession | null> {
  if (config.authProvider !== 'supabase') {
    // Local development only; config.ts refuses this provider in production.
    return {
      accessToken: '',
      user: {
        id: '1',
        email: config.adminEmail,
        name: 'Admin User',
        roles: ['admin'],
        tenantId: config.tenantId,
      },
    };
  }
  if (!config.supabaseUrl || !config.supabaseAnonKey) return null;

  const store = await cookies();
  const requestHeaders = await headers();
  const supabase = createServerClient(config.supabaseUrl, config.supabaseAnonKey, {
    cookieOptions: authCookieOptions(requestHeaders.get('host') ?? undefined),
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Server components cannot set cookies; middleware refreshes for
          // them. Actions and route handlers can, and do.
        }
      },
    },
  });

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return null;

  let payload: JWTPayload;
  try {
    payload = await verifyAccessToken(token);
  } catch (err) {
    if (!(err instanceof AuthUnavailableError)) return null;
    // Fail closed for anything that mutates: no verified identity, no action.
    throw err;
  }
  try {
    const live = await currentAuthorization(
      token,
      payload,
      config.supabaseUrl,
      config.supabaseAnonKey,
    );
    return live ? sessionFromPayload(token, live) : null;
  } catch (err) {
    if (err instanceof AuthorizationUnavailableError) throw new AuthUnavailableError(err.message);
    throw err;
  }
}
