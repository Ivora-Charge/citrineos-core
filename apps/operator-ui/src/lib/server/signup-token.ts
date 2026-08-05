// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

// Signed, expiring verification token for self-signup email confirmation.
// Format: base64url("<userId>.<expiresAtMs>") + "." + HMAC-SHA256 signature.
// Keyed on NEXTAUTH_SECRET so no extra secret needs provisioning; possession
// of the link is the proof, the payload carries no sensitive data.

import { createHmac, timingSafeEqual } from 'crypto';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h to click the link

function secret(): string {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error('NEXTAUTH_SECRET is not configured');
  return s;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function issueVerificationToken(userId: string): string {
  const payload = Buffer.from(`${userId}.${Date.now() + TOKEN_TTL_MS}`).toString(
    'base64url',
  );
  return `${payload}.${sign(payload)}`;
}

/** The userId when the token is authentic and unexpired, else undefined. */
export function verifyToken(token: string): string | undefined {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return undefined;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  const decoded = Buffer.from(payload, 'base64url').toString();
  const dot = decoded.lastIndexOf('.');
  if (dot < 1) return undefined;
  const userId = decoded.slice(0, dot);
  const expiresAt = Number(decoded.slice(dot + 1));
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return undefined;
  return userId;
}
