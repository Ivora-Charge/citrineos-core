// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use server';

import { authedAction, type ActionResult } from '@lib/utils/action-guard';
import config from '@lib/utils/config';
import { hasuraAdmin } from '@lib/server/hasura';

// Charging energy + realized Stripe revenue statistics for the dashboards.
// kWh comes from the CitrineOS Transactions table (all sessions, paid or
// not); revenue comes from the payment service, which records what was
// actually captured (hold capture + overage) per checkout. Tenant users are
// pinned to their own tenant; platform staff may query any tenant or all.

export interface StatBucket {
  sessions: number;
  kwh: number;
}

export interface RevenueBucket {
  sessions: number;
  revenue_subunits: number;
}

export interface DailyBucket {
  /** UTC day, YYYY-MM-DD */
  day: string;
  sessions: number;
  kwh: number;
  revenue_subunits: number;
}

export interface ChargingStats {
  tenantId: number | null; // null = all tenants (platform view)
  energy: { today: StatBucket; days7: StatBucket; days30: StatBucket; total: StatBucket };
  revenue: Array<{
    tenant_id: string | null;
    currency: string;
    today: RevenueBucket;
    days7: RevenueBucket;
    days30: RevenueBucket;
    total: RevenueBucket;
  }>;
  /** Last 30 UTC days, oldest first, gaps zero-filled (for the trend charts).
   * Sessions/kWh bucket on the transaction's createdAt; revenue on captured_at. */
  daily: DailyBucket[];
  /** Currency of the daily revenue series (first seen; one per tenant in practice). */
  dailyCurrency: string;
  /** tenant id -> display name; only populated for the platform-wide view. */
  tenantNames?: Record<string, string>;
}

const WINDOW_STARTS = () => {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return {
    today: today.toISOString(),
    days7: new Date(now.getTime() - 7 * 864e5).toISOString(),
    days30: new Date(now.getTime() - 30 * 864e5).toISOString(),
    total: '1970-01-01T00:00:00Z',
  };
};

const isPlatform = (roles: string[]) =>
  roles.includes('platform-admin') || roles.includes('platform-support') || roles.includes('admin');

export async function chargingStatsAction(
  tenantId?: number,
): Promise<ActionResult<ChargingStats>> {
  return authedAction<ChargingStats>(async (session) => {
    const roles = session.user.roles ?? [];
    let effectiveTenant: number | null;
    if (isPlatform(roles)) {
      effectiveTenant = tenantId ?? null; // null => whole fleet
    } else {
      const own = Number(session.user.tenantId || config.tenantId);
      if (!own) throw new Error('Session has no tenant');
      effectiveTenant = own; // tenant users can never widen the scope
    }

    // Energy: one aggregate per window, tenant-filtered when scoped.
    const starts = WINDOW_STARTS();
    const tenantFilter = effectiveTenant != null ? `tenantId: {_eq: ${effectiveTenant}},` : '';
    const windows = Object.entries(starts)
      .map(
        ([name, since]) => `
          ${name}: Transactions_aggregate(where: {${tenantFilter} createdAt: {_gte: "${since}"}}) {
            aggregate { count sum { totalKwh } }
          }`,
      )
      .join('\n');
    const energyData = await hasuraAdmin<any>(`query { ${windows} }`);
    const bucket = (name: string): StatBucket => ({
      sessions: energyData[name]?.aggregate?.count ?? 0,
      kwh: Number(energyData[name]?.aggregate?.sum?.totalKwh ?? 0),
    });

    // Revenue: the payment service owns realized money.
    const baseUrl = config.paymentServiceUrl;
    const secret = process.env.PAYMENT_CATALOG_SYNC_SECRET;
    if (!baseUrl || !secret) {
      throw new Error('Payment service URL / sync secret not configured');
    }
    const qs = effectiveTenant != null ? `?tenant_id=${effectiveTenant}` : '';
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/stats/revenue${qs}`, {
      headers: { 'X-Catalog-Sync-Secret': secret },
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`Payment stats: HTTP ${res.status}`);
    }
    const revenue = (await res.json()).tenants ?? [];

    let tenantNames: Record<string, string> | undefined;
    if (effectiveTenant == null) {
      const t = await hasuraAdmin<{ Tenants: Array<{ id: number; name: string }> }>(
        'query { Tenants { id name } }',
      );
      tenantNames = Object.fromEntries(t.Tenants.map((x) => [String(x.id), x.name]));
    }

    // Daily buckets for the trend charts: raw rows for the window, bucketed
    // here by UTC day (Hasura has no date_trunc grouping without a view; a
    // tenant's 30-day row count is small). Revenue rows come from the
    // payment_transaction_revenue view Hasura already tracks.
    const dailyData = await hasuraAdmin<{
      Transactions: Array<{ createdAt: string; totalKwh: number | null }>;
      payment_transaction_revenue: Array<{
        captured_at: string | null;
        total_received: number | null;
        currency: string | null;
      }>;
    }>(`query {
      Transactions(where: {${tenantFilter} createdAt: {_gte: "${starts.days30}"}}) {
        createdAt totalKwh
      }
      payment_transaction_revenue(where: {${tenantFilter} captured_at: {_gte: "${starts.days30}"}}) {
        captured_at total_received currency
      }
    }`);
    const dayKey = (iso: string) => iso.slice(0, 10);
    const daily = new Map<string, DailyBucket>();
    for (let i = 29; i >= 0; i--) {
      const day = dayKey(new Date(Date.now() - i * 864e5).toISOString());
      daily.set(day, { day, sessions: 0, kwh: 0, revenue_subunits: 0 });
    }
    for (const t of dailyData.Transactions) {
      const b = daily.get(dayKey(t.createdAt));
      if (b) {
        b.sessions += 1;
        b.kwh += Number(t.totalKwh ?? 0);
      }
    }
    let dailyCurrency = '';
    for (const r of dailyData.payment_transaction_revenue) {
      if (!r.captured_at) continue;
      const b = daily.get(dayKey(r.captured_at));
      if (b) b.revenue_subunits += r.total_received ?? 0;
      if (!dailyCurrency && r.currency) dailyCurrency = r.currency;
    }

    return {
      tenantNames,
      tenantId: effectiveTenant,
      energy: {
        today: bucket('today'),
        days7: bucket('days7'),
        days30: bucket('days30'),
        total: bucket('total'),
      },
      revenue,
      daily: Array.from(daily.values()),
      dailyCurrency: dailyCurrency || 'USD',
    };
  });
}
