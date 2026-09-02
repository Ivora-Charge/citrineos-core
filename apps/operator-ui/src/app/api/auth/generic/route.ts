// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Password check for the generic (local development) login. Only answers
 * when NEXT_PUBLIC_AUTH_PROVIDER=generic, which config.ts refuses in
 * production; in the Supabase mode the browser signs in with Supabase
 * directly and this endpoint is a 404.
 */

import { NextResponse } from 'next/server';
import config from '@lib/utils/config';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (config.authProvider !== 'generic') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  let body: { username?: unknown; password?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Malformed JSON body' }, { status: 400 });
  }
  if (
    !config.adminEmail ||
    !config.adminPassword ||
    body.username !== config.adminEmail ||
    body.password !== config.adminPassword
  ) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
