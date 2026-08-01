// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader } from '@lib/client/components/ui/card';
import { useTenantId } from '@lib/client/hooks/useTenantId';
import {
  chargingStatsAction,
  type ChargingStats,
  type DailyBucket,
} from '@lib/server/actions/chargingStats';

// Three small multiples over the same 30-day axis instead of one multi-scale
// chart: sessions, energy and money have incomparable units, and a dual axis
// misleads. Panels sit side by side (stat-plus-sparkline), each led by its
// 30-day total; per-day values surface via the hover tooltip. One series per
// panel, hue = the panel's identity (fixed slots --chart-1..3 from the
// validated dashboard palette).

const shortDay = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

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

interface PanelSpec {
  title: string;
  dataKey: keyof DailyBucket;
  color: string;
  format: (v: number) => string;
}

const PanelTooltip = ({
  active,
  payload,
  label,
  format,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
  format: (v: number) => string;
}) => {
  if (!active || !payload?.length || !label) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-sm">
      <span className="text-muted-foreground">{shortDay(label)}</span>{' '}
      <span className="font-medium text-popover-foreground">{format(payload[0].value)}</span>
    </div>
  );
};

const TrendPanel = ({ data, spec }: { data: DailyBucket[]; spec: PanelSpec }) => {
  const values = data.map((d) => Number(d[spec.dataKey] ?? 0));
  const max = Math.max(0, ...values);
  const total = values.reduce((a, b) => a + b, 0);

  return (
    <div>
      <p className="text-xs text-muted-foreground">{spec.title}</p>
      <p className="text-lg font-semibold tabular-nums mb-1">{spec.format(total)}</p>
      <ResponsiveContainer width="100%" height={64}>
        <BarChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 0 }} barCategoryGap={2}>
          <XAxis
            dataKey="day"
            tickFormatter={shortDay}
            ticks={data.filter((_, i) => i % 14 === 1).map((d) => d.day)}
            tick={{ fontSize: 9, fill: 'var(--muted-foreground)' }}
            axisLine={{ stroke: 'var(--border)' }}
            tickLine={false}
          />
          <YAxis hide domain={[0, max > 0 ? 'auto' : 1]} />
          <Tooltip
            cursor={{ fill: 'var(--accent)', opacity: 0.4 }}
            content={<PanelTooltip format={spec.format} />}
          />
          <Bar
            dataKey={spec.dataKey}
            fill={spec.color}
            fillOpacity={0.9}
            radius={[2, 2, 0, 0]}
            maxBarSize={10}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

/** 30-day daily trends: sessions, energy and captured revenue, one panel each
 * on a shared UTC-day axis. */
export const TrendsCard = () => {
  const tenantId = useTenantId();
  const [stats, setStats] = useState<ChargingStats | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void chargingStatsAction(tenantId).then((res) => {
      if (res.success) setStats(res.data);
      else setErr(res.error);
    });
  }, [tenantId]);

  const panels: PanelSpec[] = useMemo(() => {
    const currency = stats?.dailyCurrency ?? 'USD';
    return [
      {
        title: 'Sessions',
        dataKey: 'sessions',
        color: 'var(--chart-1)',
        format: (v) => `${v}`,
      },
      {
        title: 'Energy delivered',
        dataKey: 'kwh',
        color: 'var(--chart-2)',
        format: (v) => `${v.toFixed(1)} kWh`,
      },
      {
        title: 'Revenue captured',
        dataKey: 'revenue_subunits',
        color: 'var(--chart-3)',
        format: (v) => money(v, currency),
      },
    ];
  }, [stats?.dailyCurrency]);

  const daily = stats?.daily ?? [];

  return (
    <Card className="h-full">
      <CardHeader>
        <h3 className="font-semibold">Last 30 days</h3>
        <p className="text-xs text-muted-foreground">
          Daily sessions, delivered energy, and captured revenue (UTC days)
        </p>
      </CardHeader>
      <CardContent>
        {err ? (
          <p className="text-sm text-destructive">{err}</p>
        ) : !stats ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-6">
            {panels.map((spec) => (
              <TrendPanel key={spec.title} data={daily} spec={spec} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
