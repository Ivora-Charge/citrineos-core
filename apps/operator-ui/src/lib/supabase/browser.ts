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
import { authCookieOptions } from '@lib/utils/auth-cookie';

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
  return client;
}
