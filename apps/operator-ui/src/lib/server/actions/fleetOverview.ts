// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use server';

import { authedAction, type ActionResult } from '@lib/utils/action-guard';
import { hasuraAdmin } from '@lib/server/hasura';

// Cross-tenant fleet health for Ivora support staff (multi-tenant Phase 7).
// Admin-secret reads, gated here to platform roles -- tenant users never see
// other tenants' fleet state.

export interface FleetOverview {
  offline: Array<{ station: string; tenant: string; since: string }>;
  faulted: Array<{ station: string; connectorId: number | null }>;
  activeSessions: Array<{
    station: string;
    tenant: string;
    transactionId: string;
    startedAt: string;
    kwh: number | null;
  }>;
  firmware: Array<{ version: string; count: number }>;
  totals: { stations: number; online: number };
}

const FLEET_QUERY = `
  query FleetOverview {
    ChargingStations(order_by: { ocppConnectionName: asc }) {
      ocppConnectionName
      isOnline
      updatedAt
      firmwareVersion
      Tenant { name }
    }
    LatestStatusNotifications(
      where: { StatusNotification: { connectorStatus: { _eq: "Faulted" } } }
    ) {
      StatusNotification {
        ocppConnectionName
        connectorId
      }
    }
    Transactions(where: { isActive: { _eq: true } }, order_by: { createdAt: asc }) {
      ocppConnectionName
      transactionId
      totalKwh
      createdAt
      ChargingStation { Tenant { name } }
    }
  }
`;

export async function fleetOverviewAction(): Promise<ActionResult<FleetOverview>> {
  return authedAction<FleetOverview>(async (session) => {
    const roles = session.user.roles ?? [];
    if (
      !roles.includes('platform-admin') &&
      !roles.includes('platform-support') &&
      !roles.includes('admin')
    ) {
      throw new Error('Platform staff only');
    }

    const data = await hasuraAdmin<any>(FLEET_QUERY);
    const stations = data.ChargingStations ?? [];

    const firmwareCounts = new Map<string, number>();
    for (const s of stations) {
      const v = s.firmwareVersion || 'unknown';
      firmwareCounts.set(v, (firmwareCounts.get(v) ?? 0) + 1);
    }

    return {
      offline: stations
        .filter((s: any) => !s.isOnline)
        .map((s: any) => ({
          station: s.ocppConnectionName,
          tenant: s.Tenant?.name ?? '—',
          since: s.updatedAt,
        })),
      faulted: (data.LatestStatusNotifications ?? []).map((l: any) => ({
        station: l.StatusNotification?.ocppConnectionName ?? '?',
        connectorId: l.StatusNotification?.connectorId ?? null,
      })),
      activeSessions: (data.Transactions ?? []).map((t: any) => ({
        station: t.ocppConnectionName,
        tenant: t.ChargingStation?.Tenant?.name ?? '—',
        transactionId: t.transactionId,
        startedAt: t.createdAt,
        kwh: t.totalKwh,
      })),
      firmware: [...firmwareCounts.entries()]
        .map(([version, count]) => ({ version, count }))
        .sort((a, b) => b.count - a.count),
      totals: {
        stations: stations.length,
        online: stations.filter((s: any) => s.isOnline).length,
      },
    };
  });
}
