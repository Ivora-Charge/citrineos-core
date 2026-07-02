// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { Button } from '@lib/client/components/ui/button';
import { Card, CardContent, CardHeader } from '@lib/client/components/ui/card';
import { fleetOverviewAction, type FleetOverview } from '@lib/server/actions/fleetOverview';
import { heading2Style, heading3Style, pageMargin } from '@lib/client/styles/page';
import { buttonIconSize } from '@lib/client/styles/icon';

const ago = (iso: string) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / (60 * 24))}d`;
};

/** Cross-tenant fleet health for Ivora support (platform staff only; the
 * server action rejects tenant users). */
export const FleetOverviewPage = () => {
  const [data, setData] = useState<FleetOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fleetOverviewAction();
    if (res.success) {
      setData(res.data);
      setErr(null);
    } else {
      setErr(res.error);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [load]);

  if (err) {
    return (
      <Card className={pageMargin}>
        <CardContent className="py-8 text-destructive">{err}</CardContent>
      </Card>
    );
  }

  return (
    <Card className={pageMargin}>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <h2 className={heading2Style}>Fleet</h2>
          <p className="text-sm text-muted-foreground">
            {data
              ? `${data.totals.online}/${data.totals.stations} chargers online — all tenants. Refreshes every 30s.`
              : 'Loading…'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className={buttonIconSize} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-8">
        <section>
          <h3 className={heading3Style}>
            Offline chargers {data ? `(${data.offline.length})` : ''}
          </h3>
          {data && data.offline.length === 0 ? (
            <p className="text-sm text-muted-foreground">Everything is online.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4">Station</th>
                  <th className="py-2 pr-4">Tenant</th>
                  <th className="py-2">Offline for</th>
                </tr>
              </thead>
              <tbody>
                {(data?.offline ?? []).map((s) => (
                  <tr key={s.station} className="border-b">
                    <td className="py-2 pr-4 font-mono">{s.station}</td>
                    <td className="py-2 pr-4">{s.tenant}</td>
                    <td className="py-2">{ago(s.since)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h3 className={heading3Style}>Faulted connectors {data ? `(${data.faulted.length})` : ''}</h3>
          {data && data.faulted.length === 0 ? (
            <p className="text-sm text-muted-foreground">No faults reported.</p>
          ) : (
            <ul className="text-sm font-mono">
              {(data?.faulted ?? []).map((f, i) => (
                <li key={i}>
                  {f.station} (connector {f.connectorId ?? '?'})
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className={heading3Style}>
            Active charging sessions {data ? `(${data.activeSessions.length})` : ''}
          </h3>
          {data && data.activeSessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sessions in progress.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4">Station</th>
                  <th className="py-2 pr-4">Tenant</th>
                  <th className="py-2 pr-4">Running for</th>
                  <th className="py-2">kWh</th>
                </tr>
              </thead>
              <tbody>
                {(data?.activeSessions ?? []).map((t) => (
                  <tr key={t.transactionId} className="border-b">
                    <td className="py-2 pr-4 font-mono">{t.station}</td>
                    <td className="py-2 pr-4">{t.tenant}</td>
                    <td className="py-2 pr-4">{ago(t.startedAt)}</td>
                    <td className="py-2">{t.kwh?.toFixed(3) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h3 className={heading3Style}>Firmware spread</h3>
          <ul className="text-sm">
            {(data?.firmware ?? []).map((f) => (
              <li key={f.version}>
                <span className="font-mono">{f.version}</span> × {f.count}
              </li>
            ))}
          </ul>
        </section>
      </CardContent>
    </Card>
  );
};
