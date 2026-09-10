// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Single sign-on cookie (docs/identity-consolidation-plan.md, SSO addendum).
 *
 * The Supabase session lives in the browser cookie @supabase/ssr manages,
 * named sb-<project-ref>-auth-token and chunked when large. When
 * NEXT_PUBLIC_AUTH_COOKIE_DOMAIN is set to the parent domain
 * (".ivoracharge.com"), the apps using that Supabase project read and write
 * the SAME cookie: signing in on either product signs the user in on both, and a
 * sign-out on either ends both. Every client (browser and server, in both
 * products) must pass identical cookie options, otherwise the browser keeps
 * two cookies of the same name (host-only and domain) and the apps disagree
 * about who is logged in.
 *
 * Test and production use different projects and therefore different cookie
 * names. Unset (local development on localhost) the cookie is host-only.
 */

import type { CookieOptionsWithName } from '@supabase/ssr';

export const AUTH_COOKIE_DOMAIN = process.env.NEXT_PUBLIC_AUTH_COOKIE_DOMAIN?.trim() || undefined;

export function authCookieOptionsForHost(
  configuredDomain: string | undefined,
  environment: string | undefined,
  host: string | undefined,
): CookieOptionsWithName {
  let hostname = host;
  try {
    if (host) hostname = new URL(`http://${host}`).hostname;
  } catch { /* An unrecognised host keeps the configured scope. */ }
  const local = hostname === 'localhost' || hostname?.endsWith('.localhost') ||
    hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  const domain = environment === 'test' && local ? undefined : configuredDomain;
  return {
    path: '/',
    sameSite: 'lax',
    // HTTPS public hosts share cookies; local test origins remain host-only.
    ...(domain ? { domain, secure: true } : {}),
  };
}

export const authCookieOptions = (host?: string): CookieOptionsWithName =>
  authCookieOptionsForHost(
    AUTH_COOKIE_DOMAIN,
    process.env.CSMS_ENV || process.env.NEXT_PUBLIC_CSMS_ENV,
    host ?? (typeof window !== 'undefined' ? window.location.hostname : undefined),
  );
