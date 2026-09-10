// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Browser-side Supabase client. Sessions are stored in the shared SSO cookie
 * (see @lib/utils/auth-cookie), never in localStorage, so the Next.js server
 * (middleware, server actions, the core proxy) and the analytics product see
 * the same session. Auto-refresh is on: the rotated tokens are written back
 * to the cookie for everyone.
 */

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import config from '@lib/utils/config';
import { AUTH_COOKIE_DOMAIN, authCookieOptions } from '@lib/utils/auth-cookie';
import { migrateTestAuthCookies, writeTestLogoutMarker } from '@lib/utils/test-auth-cookie-migration';

const testCookieContext = () => typeof window === 'undefined' ? null : ({
  environment: config.csmsEnv,
  supabaseUrl: config.supabaseUrl,
  cookieDomain: AUTH_COOKIE_DOMAIN,
  hostname: window.location.hostname,
  protocol: window.location.protocol,
  cookies: document,
});

export function recordTestSignOut(): void {
  const context = testCookieContext();
  if (context) writeTestLogoutMarker(context, true);
}

export function recordExplicitTestSignIn(): void {
  const context = testCookieContext();
  if (context) writeTestLogoutMarker(context, false);
}

// Run when the login page loads too, before any SDK client can read or refresh
// duplicate host/domain cookies. Reload once so middleware sees the same
// canonical shared session as the browser after migration.
const migrationContext = testCookieContext();
if (migrationContext && migrateTestAuthCookies(migrationContext)) {
  window.location.reload();
}

let client: SupabaseClient | undefined;

export function getBrowserSupabase(): SupabaseClient {
  if (client) return client;
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set');
  }
  client = createBrowserClient(config.supabaseUrl, config.supabaseAnonKey, {
    cookieOptions: authCookieOptions(),
    isSingleton: true,
  });
  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') recordTestSignOut();
  });
  return client;
}
