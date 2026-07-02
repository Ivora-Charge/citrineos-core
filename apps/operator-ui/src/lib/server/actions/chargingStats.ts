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
    };
  });
}
