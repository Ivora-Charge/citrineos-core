// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

// Email-verification landing for self-signup: a valid signed token enables
// the Keycloak account (and marks the email verified), then points the user
// at /login. Public route (see middleware matcher).

import { NextRequest, NextResponse } from 'next/server';

import { activateUser } from '@lib/server/keycloak-admin';
import { verifyToken } from '@lib/server/signup-token';

function page(title: string, body: string, ok: boolean) {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${title}</title>` +
      `<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;` +
      `justify-content:center;min-height:100vh;margin:0;background:#f5f5f4}` +
      `main{max-width:26rem;padding:2rem;background:#fff;border-radius:12px;` +
      `box-shadow:0 1px 4px rgba(0,0,0,.08);text-align:center}` +
      `a{color:#2d6a4f;font-weight:600}</style></head>` +
      `<body><main><h1 style="font-size:1.25rem">${title}</h1>` +
      `<p>${body}</p>` +
      (ok ? `<p><a href="/login">Sign in</a></p>` : '') +
      `</main></body></html>`,
    { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html' } },
  );
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token') ?? '';
  const userId = verifyToken(token);
  if (!userId) {
    return page(
      'Verification link invalid',
      'This link is invalid or has expired (links are valid for 24 hours). Please sign up again.',
      false,
    );
  }
  try {
    await activateUser(userId);
  } catch (err) {
    console.error('[self-signup] activation failed:', err);
    return page(
      'Something went wrong',
      'We could not activate your account. Please try the link again or contact support.',
      false,
    );
  }
  return page(
    'Email verified',
    'Your account is active. You can sign in now and start onboarding your chargers.',
    true,
  );
}
