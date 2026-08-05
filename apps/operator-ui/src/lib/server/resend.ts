// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

// Minimal Resend transport for transactional email (self-signup verification).
// Server-only: RESEND_API_KEY must never reach the client bundle. The sending
// domain must be verified in the Resend account (ivoracharge.com).

const RESEND_API_URL = 'https://api.resend.com/emails';

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');
  const from =
    process.env.SIGNUP_EMAIL_FROM || 'Ivora Charge <no-reply@ivoracharge.com>';

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [args.to], subject: args.subject, html: args.html }),
    cache: 'no-store',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend send failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
}
