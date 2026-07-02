// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@lib/client/components/ui/card';
import { useTenantId } from '@lib/client/hooks/useTenantId';
import {
  chargingStatsAction,
  type ChargingStats,
} from '@lib/server/actions/chargingStats';

const money = (subunits: number, currency: string) => {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(subunits / 100);
  } catch {
    return `${(subunits / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
};

const kwh = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} MWh` : `${v.toFixed(1)} kWh`);

/** Energy delivered + realized Stripe revenue for the caller's tenant
 * (today / 7d / 30d / all-time). Revenue is what was actually captured
 * (hold capture + overage), summed from the payment service. */
export const EnergyRevenueCard = () => {
  const tenantId = useTenantId();
  const [stats, setStats] = useState<ChargingStats | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void chargingStatsAction(tenantId).then((res) => {
      if (res.success) setStats(res.data);
      else setErr(res.error);
    });
  }, [tenantId]);

  // One currency per tenant in practice; sum defensively across rows anyway.
  const revenueFor = (w: 'today' | 'days7' | 'days30' | 'total') => {
    const rows = stats?.revenue ?? [];
    if (rows.length === 0) return money(0, 'usd');
    const currency = rows[0].currency;
    const total = rows.reduce((s, r) => s + (r[w]?.revenue_subunits ?? 0), 0);
    return money(total, currency);
  };

  const windows: Array<['today' | 'days7' | 'days30' | 'total', string]> = [
    ['today', 'Today'],
    ['days7', '7 days'],
    ['days30', '30 days'],
    ['total', 'All time'],
  ];

  return (
    <Card className="h-full">
      <CardHeader>
        <h3 className="font-semibold">Energy & revenue</h3>
        <p className="text-xs text-muted-foreground">
          Delivered energy and captured Stripe revenue
        </p>
      </CardHeader>
      <CardContent>
        {err ? (
          <p className="text-sm text-destructive">{err}</p>
        ) : !stats ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground border-b">
                <th className="py-1 pr-2" />
                <th className="py-1 pr-2">Sessions</th>
                <th className="py-1 pr-2">Energy</th>
                <th className="py-1">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {windows.map(([w, label]) => (
                <tr key={w} className="border-b border-border/50">
                  <td className="py-1.5 pr-2 text-muted-foreground">{label}</td>
                  <td className="py-1.5 pr-2">{stats.energy[w].sessions}</td>
                  <td className="py-1.5 pr-2">{kwh(stats.energy[w].kwh)}</td>
                  <td className="py-1.5 font-medium">{revenueFor(w)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
};
