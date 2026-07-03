// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader } from '@lib/client/components/ui/card';
import { useTenantId } from '@lib/client/hooks/useTenantId';
import {
  chargingStatsAction,
  type ChargingStats,
  type DailyBucket,
} from '@lib/server/actions/chargingStats';

// Three small multiples over the same 30-day axis instead of one multi-scale
// chart: sessions, energy and money have incomparable units, and a dual axis
// misleads. One series per panel (hue = the panel's identity, fixed slots
// --chart-1..3 from the validated dashboard palette); the panel title names
// the series, values surface via hover tooltip + a direct label on the peak
// day (the tooltip/label pair is the contrast relief for the lighter hues).

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

const TrendPanel = ({
  data,
  spec,
  showXAxis,
}: {
  data: DailyBucket[];
  spec: PanelSpec;
  showXAxis: boolean;
}) => {
  const values = data.map((d) => Number(d[spec.dataKey] ?? 0));
  const max = Math.max(...values);
  const maxIndex = values.indexOf(max);

  // Direct label only on the peak day (selective, not every bar), and only
  // when there is any data at all.
  const peakLabel = ({ x, y, width, index, value }: any) =>
    max > 0 && index === maxIndex && value === max ? (
      <text
        x={x + width / 2}
        y={y - 4}
        textAnchor="middle"
        className="fill-muted-foreground"
        fontSize={10}
      >
        {spec.format(value)}
      </text>
    ) : null;

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-1">{spec.title}</p>
      <ResponsiveContainer width="100%" height={96}>
        <BarChart data={data} margin={{ top: 12, right: 4, left: 4, bottom: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
          <XAxis
            dataKey="day"
            hide={!showXAxis}
            tickFormatter={shortDay}
            ticks={data.filter((_, i) => i % 7 === 1).map((d) => d.day)}
            tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
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
            radius={[4, 4, 0, 0]}
            maxBarSize={14}
            label={peakLabel}
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
        title: 'Sessions / day',
        dataKey: 'sessions',
        color: 'var(--chart-1)',
        format: (v) => `${v}`,
      },
      {
        title: 'Energy delivered (kWh) / day',
        dataKey: 'kwh',
        color: 'var(--chart-2)',
        format: (v) => `${v.toFixed(1)} kWh`,
      },
      {
        title: 'Revenue captured / day',
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
          <div className="flex flex-col gap-2">
            {panels.map((spec, i) => (
              <TrendPanel
                key={spec.title}
                data={daily}
                spec={spec}
                showXAxis={i === panels.length - 1}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
