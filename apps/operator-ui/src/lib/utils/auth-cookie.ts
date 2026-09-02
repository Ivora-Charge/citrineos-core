// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Single sign-on cookie (docs/identity-consolidation-plan.md, SSO addendum).
 *
 * The Supabase session lives in the browser cookie @supabase/ssr manages,
 * named sb-<project-ref>-auth-token and chunked when large. When
 * NEXT_PUBLIC_AUTH_COOKIE_DOMAIN is set to the parent domain
 * (".ivoracharge.com"), analytics.* and csms.* read and write the SAME
 * cookie: signing in on either product signs the user in on both, and a
 * sign-out on either ends both. Every client (browser and server, in both
 * products) must pass identical cookie options, otherwise the browser keeps
 * two cookies of the same name (host-only and domain) and the apps disagree
 * about who is logged in.
 *
 * Unset (local development on localhost) the cookie is host-only.
 */

import type { CookieOptionsWithName } from '@supabase/ssr';

export const AUTH_COOKIE_DOMAIN = process.env.NEXT_PUBLIC_AUTH_COOKIE_DOMAIN?.trim() || undefined;

export const authCookieOptions = (): CookieOptionsWithName => ({
  path: '/',
  sameSite: 'lax',
  // A parent-domain cookie is only ever set over TLS (Cloudflare + nginx
  // terminate it; the Next.js server itself listens on plain HTTP).
  ...(AUTH_COOKIE_DOMAIN ? { domain: AUTH_COOKIE_DOMAIN, secure: true } : {}),
});
