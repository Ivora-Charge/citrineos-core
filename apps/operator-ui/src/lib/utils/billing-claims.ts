// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Billing state carried in the Supabase JWT, written by the analytics
 * "Users & plans" admin tab:
 *
 *   app_metadata.billing = { "status": "active" | "past_due" | "suspended",
 *                            "until": "YYYY-MM-DD" (optional), "note": "..." }
 *
 * Absent means active. "suspended", or an "until" date that has passed,
 * blocks sign-in here and every authenticated call on the analytics API; the
 * user keeps their account and claims so lifting the block is one edit.
 * "past_due" is informational (banner on the analytics side) and does not
 * block. Like the CSMS claims this is read from the verified token only, so
 * a change reaches enforcement at the next token refresh (up to an hour).
 */

export type BillingBlock = 'suspended' | 'expired';

export function readBillingBlock(claims: unknown, now: Date = new Date()): BillingBlock | null {
  const appMeta = (claims as { app_metadata?: unknown } | null)?.app_metadata;
  if (!appMeta || typeof appMeta !== 'object') return null;
  const billing = (appMeta as { billing?: unknown }).billing;
  if (!billing || typeof billing !== 'object') return null;

  const status = (billing as { status?: unknown }).status;
  if (status === 'suspended') return 'suspended';

  const until = (billing as { until?: unknown }).until;
  if (typeof until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(until)) {
    // Blocked from the day AFTER `until`, compared in UTC.
    const today = now.toISOString().slice(0, 10);
    if (today > until) return 'expired';
  }
  return null;
}
