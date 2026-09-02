// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { createServerClient } from '@supabase/ssr';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { authCookieOptions } from '@lib/utils/auth-cookie';
import { readCsmsClaims } from '@lib/utils/csms-claims';
import { readBillingBlock } from '@lib/utils/billing-claims';

/**
 * Server-side authentication middleware.
 *
 * The session is the Supabase session in the shared SSO cookie
 * (@lib/utils/auth-cookie): signing in on analytics.* signs the user in
 * here. On every matched request this
 *
 *  1. loads the session from the cookie, refreshing an expired access token
 *     and writing the rotated pair back onto the response (so a user who
 *     only has this tab open stays signed in);
 *  2. verifies the token signature against the Supabase JWKS;
 *  3. requires valid CSMS claims for CSMS_ENV and no billing block.
 *
 * Anything else is sent to /login with a reason. /login itself is matched
 * too: a visitor who already holds a valid session (arrived from the
 * launcher) is taken straight to /overview.
 *
 * Server actions and the core proxy repeat these checks
 * (@lib/server/session); this layer is what keeps pages from rendering for
 * strangers. Hasura verifies the token again on every query.
 */

type Reason = 'NoSession' | 'NoAccess' | 'Suspended' | 'SessionExpired';

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function middleware(request: NextRequest) {
  const provider = process.env.NEXT_PUBLIC_AUTH_PROVIDER;
  // skip server side auth for generic auth provider (local development only;
  // config.ts refuses to start with it in production)
  if (!provider || provider === 'generic') {
    return NextResponse.next();
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const csmsEnv = process.env.CSMS_ENV;
  const isLogin = request.nextUrl.pathname === '/login';
  if (!supabaseUrl || !anonKey || !csmsEnv) {
    return isLogin ? NextResponse.next() : toLogin(request, 'NoSession', null);
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(supabaseUrl, anonKey, {
    cookieOptions: authCookieOptions(),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });

  let reason: Reason | null = null;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    reason = 'NoSession';
  } else {
    const issuer = `${supabaseUrl}/auth/v1`;
    jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });
    let payload: unknown = null;
    try {
      payload = (await jwtVerify(session.access_token, jwks, { issuer, audience: 'authenticated' }))
        .payload;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'ERR_JWKS_TIMEOUT' || err instanceof TypeError) {
        // Key set unreachable: let the page shell render on the unverified
        // claims. Every data call (Hasura, server actions, the core proxy)
        // still verifies the signature itself.
        console.warn('[auth] JWKS unavailable, rendering shell on unverified claims');
        payload = decodePayload(session.access_token);
      } else {
        reason = 'SessionExpired';
      }
    }
    if (payload && !reason) {
      if (!readCsmsClaims(payload, csmsEnv)) reason = 'NoAccess';
      else if (readBillingBlock(payload)) reason = 'Suspended';
    }
  }

  if (isLogin) {
    if (reason) return response;
    return redirectWithCookies(new URL('/overview', request.url), response);
  }
  if (reason) return toLogin(request, reason, response);
  return response;
}

function decodePayload(token: string): unknown {
  try {
    const part = token.split('.')[1] ?? '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function toLogin(request: NextRequest, reason: Reason, response: NextResponse | null) {
  // API callers (the core proxy, fetch() from the app) get a 401, not a
  // redirect to an HTML page.
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const res = NextResponse.json({ error: 'Unauthenticated', reason }, { status: 401 });
    if (response) {
      for (const cookie of response.cookies.getAll()) res.cookies.set(cookie);
    }
    return res;
  }
  const loginUrl = new URL('/login', request.url);
  if (reason !== 'NoSession') loginUrl.searchParams.set('error', reason);
  return redirectWithCookies(loginUrl, response);
}

/** Redirects must carry any refreshed session cookies too. */
function redirectWithCookies(url: URL, response: NextResponse | null) {
  const redirect = NextResponse.redirect(url);
  if (response) {
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
  }
  return redirect;
}

export const config = {
  matcher: [
    /*
     * Match every path EXCEPT:
     *   /api/auth/**            – the generic dev login endpoint
     *   /api/health             – public health-check (load balancers, probes)
     *   /_next/static/**        – Next.js compiled assets
     *   /_next/image/**         – Next.js image optimisation endpoint
     *   /favicon.ico            – browser favicon
     *   /<file>.<ext>           – any root-level static file (svg, png, etc.)
     * /login IS matched: a valid session there redirects to /overview.
     */
    '/((?!api/auth|api/health|_next/static|_next/image|favicon\\.ico|[^/]+\\.[^/]+$).*)',
  ],
};
