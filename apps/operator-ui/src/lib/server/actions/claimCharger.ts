// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use server';

import { authedAction, type ActionResult } from '@lib/utils/action-guard';
import config from '@lib/utils/config';
import { hasuraAdmin } from '@lib/server/hasura';
import { audit } from '@lib/server/audit';
import { syncTariffToPaymentAction } from './syncTariffToPayment';

/**
 * Charger inventory & claim flow (multi-tenant rollout Phase 4).
 *
 * Chargers Ivora ships are pre-registered under the "Ivora Inventory" tenant
 * (they connect to the central OCPP endpoint at the factory, so their
 * ChargingStations row already exists). Activation = a tenant admin (or a
 * platform admin acting for a tenant) claims the unit by the serial number
 * printed on it; the station and its Evses/Connectors flip to the target
 * tenant and any assigned tariffs re-sync to the payment service under the
 * new tenant.
 *
 * All reads/writes use the server-side admin secret because they necessarily
 * cross tenant boundaries (inventory -> target tenant); the caller's
 * authority is enforced here instead.
 */

const INVENTORY_TENANT_NAME = 'Ivora Inventory';

const isPlatformAdmin = (roles: string[]) =>
  roles.includes('platform-admin') || roles.includes('admin');

/** Drop the charger's live OCPP connection so it reconnects. CitrineOS
 * resolves a station's tenant when the websocket is established, so after a
 * tenant move the old connection keeps stamping events with the previous
 * tenant -- the OCPPMessages trigger then rejects every event (and payment
 * hears nothing) until the charger reconnects. Must be called with the tenant
 * the connection is currently registered under (the OLD one). Best-effort:
 * an offline charger has no connection to drop and reconnects correctly on
 * its own. */
async function dropStationConnection(stationName: string, oldTenantId: number): Promise<void> {
  const base = config.citrineCoreUrl;
  if (!base) return;
  try {
    const res = await fetch(
      `${base.replace(/\/$/, '')}/data/ocpprouter/connection` +
        `?ocppConnectionName=${encodeURIComponent(stationName)}&tenantId=${oldTenantId}`,
      { method: 'DELETE', cache: 'no-store' },
    );
    if (!res.ok) {
      console.error(`[claim] connection drop failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error('[claim] connection drop failed:', err);
  }
}

/** Keep the payment service's EVSE rows pointing at the station's new tenant.
 * Best-effort: the payment side heals on the next catalog sync anyway, but
 * without this, revenue attribution and outbound CitrineOS calls use the old
 * tenant until a tariff re-sync happens (which may be never for a freshly
 * claimed charger). */
async function reassignPaymentStation(stationName: string, tenantId: number): Promise<void> {
  const baseUrl = config.paymentServiceUrl;
  const secret = process.env.PAYMENT_CATALOG_SYNC_SECRET;
  if (!baseUrl || !secret) return;
  try {
    const res = await fetch(
      `${baseUrl.replace(/\/$/, '')}/api/catalog/reassign-station` +
        `?station_id=${encodeURIComponent(stationName)}&tenant_id=${tenantId}`,
      { method: 'POST', headers: { 'X-Catalog-Sync-Secret': secret }, cache: 'no-store' },
    );
    if (!res.ok) {
      console.error(`[claim] payment reassign failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error('[claim] payment reassign failed:', err);
  }
}

async function inventoryTenantId(): Promise<number> {
  const data = await hasuraAdmin<{ Tenants: Array<{ id: number }> }>(
    `query { Tenants(where: {name: {_eq: "${INVENTORY_TENANT_NAME}"}}) { id } }`,
  );
  if (!data.Tenants.length) {
    throw new Error(
      `Inventory tenant "${INVENTORY_TENANT_NAME}" not found -- create it on the /tenants page first`,
    );
  }
  return data.Tenants[0].id;
}

const STATION_BY_SERIAL = `
  query StationBySerial($tenantId: Int!, $serial: String!) {
    ChargingStations(
      where: {
        tenantId: { _eq: $tenantId }
        _or: [
          { chargePointSerialNumber: { _eq: $serial } }
          { chargeBoxSerialNumber: { _eq: $serial } }
          { ocppConnectionName: { _eq: $serial } }
        ]
      }
    ) {
      id
      ocppConnectionName
      chargePointVendor
      chargePointModel
    }
  }
`;

const MOVE_STATION = `
  mutation MoveStation($stationId: Int!, $tenantId: Int!, $locationId: Int) {
    update_ChargingStations_by_pk(
      pk_columns: { id: $stationId }
      _set: { tenantId: $tenantId, locationId: $locationId }
    ) {
      id
    }
    update_Evses(where: { stationId: { _eq: $stationId } }, _set: { tenantId: $tenantId }) {
      affected_rows
    }
    update_Connectors(where: { stationId: { _eq: $stationId } }, _set: { tenantId: $tenantId }) {
      affected_rows
    }
  }
`;

export interface ClaimResult {
  stationId: number;
  ocppConnectionName: string;
  tenantId: number;
}

/**
 * Claim a charger from inventory by serial number (or its OCPP station id,
 * for units that don't report a serial). Tenant admins claim into their own
 * tenant; platform admins may claim for any tenant via targetTenantId.
 */
export async function claimChargerAction(input: {
  serial: string;
  targetTenantId?: number;
  locationId?: number;
}): Promise<ActionResult<ClaimResult>> {
  return authedAction<ClaimResult>(async (session) => {
    const roles = session.user.roles ?? [];
    const platform = isPlatformAdmin(roles);
    if (!platform && !roles.includes('tenant-admin')) {
      throw new Error('Only tenant or platform admins can claim chargers');
    }

    let tenantId: number;
    if (platform) {
      tenantId = input.targetTenantId ?? Number(session.user.tenantId || config.tenantId);
    } else {
      tenantId = Number(session.user.tenantId);
      if (!tenantId) throw new Error('Session has no tenant');
      if (input.targetTenantId && input.targetTenantId !== tenantId) {
        throw new Error('Tenant admins can only claim into their own tenant');
      }
    }

    const serial = input.serial.trim();
    if (!serial) throw new Error('Serial number is required');

    const invId = await inventoryTenantId();
    if (tenantId === invId) throw new Error('Cannot claim into the inventory tenant');

    const found = await hasuraAdmin<{ ChargingStations: any[] }>(STATION_BY_SERIAL, {
      tenantId: invId,
      serial,
    });
    if (found.ChargingStations.length === 0) {
      throw new Error(
        `No unclaimed charger with serial "${serial}" -- check the number, or ask Ivora support if the unit was registered`,
      );
    }
    const station = found.ChargingStations[0];

    // A provided location must belong to the target tenant.
    let locationId: number | null = null;
    if (input.locationId) {
      const loc = await hasuraAdmin<{ Locations_by_pk: { tenantId: number } | null }>(
        `query($id: Int!) { Locations_by_pk(id: $id) { tenantId } }`,
        { id: input.locationId },
      );
      if (!loc.Locations_by_pk || loc.Locations_by_pk.tenantId !== tenantId) {
        throw new Error('Location does not belong to the target tenant');
      }
      locationId = input.locationId;
    }

    await hasuraAdmin(MOVE_STATION, { stationId: station.id, tenantId, locationId });
    await reassignPaymentStation(station.ocppConnectionName, tenantId);
    // The live connection is registered under the inventory tenant; drop it so
    // the charger reconnects under its new owner.
    await dropStationConnection(station.ocppConnectionName, invId);

    // Re-sync any tariffs already wired to this station's connectors so the
    // payment catalog rows move to the new tenant too (get_or_create in
    // citrineos-payment refreshes tenant_id on existing EVSEs).
    const tariffs = await hasuraAdmin<{ Connectors: Array<{ tariffId: number | null }> }>(
      `query($sid: Int!) { Connectors(where: {stationId: {_eq: $sid}, tariffId: {_is_null: false}}, distinct_on: tariffId) { tariffId } }`,
      { sid: station.id },
    );
    for (const c of tariffs.Connectors) {
      if (c.tariffId) {
        await syncTariffToPaymentAction(c.tariffId, {
          tenantIdOverride: platform ? String(tenantId) : undefined,
        });
      }
    }

    await audit({
      actor: session.user.email ?? session.user.name ?? 'unknown',
      actorRoles: roles,
      tenantId,
      action: 'charger.claim',
      target: station.ocppConnectionName,
      detail: { serial, stationId: station.id, locationId },
    });

    return {
      stationId: station.id,
      ocppConnectionName: station.ocppConnectionName,
      tenantId,
    };
  });
}

/** Platform-only: move a charger (back) into the Ivora Inventory tenant --
 * used both for pre-registering units and for returns/transfers. Refuses
 * while a charging session is active. */
export async function moveToInventoryAction(
  ocppConnectionName: string,
): Promise<ActionResult<ClaimResult>> {
  return authedAction<ClaimResult>(async (session) => {
    const roles = session.user.roles ?? [];
    if (!isPlatformAdmin(roles)) {
      throw new Error('Only platform admins can move chargers to inventory');
    }

    const data = await hasuraAdmin<{ ChargingStations: any[] }>(
      `query($name: String!) {
         ChargingStations(where: {ocppConnectionName: {_eq: $name}}) {
           id
           ocppConnectionName
           tenantId
           Transactions: Transactions_aggregate(where: {isActive: {_eq: true}}) {
             aggregate { count }
           }
         }
       }`,
      { name: ocppConnectionName.trim() },
    );
    if (!data.ChargingStations.length) {
      throw new Error(`No charger with station id "${ocppConnectionName}"`);
    }
    const station = data.ChargingStations[0];
    if (station.Transactions.aggregate.count > 0) {
      throw new Error('Charger has an active charging session -- stop it first');
    }

    const invId = await inventoryTenantId();
    await hasuraAdmin(MOVE_STATION, { stationId: station.id, tenantId: invId, locationId: null });
    await reassignPaymentStation(station.ocppConnectionName, invId);
    await dropStationConnection(station.ocppConnectionName, station.tenantId);

    await audit({
      actor: session.user.email ?? session.user.name ?? 'unknown',
      actorRoles: roles,
      action: 'charger.move-to-inventory',
      target: station.ocppConnectionName,
      detail: { stationId: station.id },
    });

    return {
      stationId: station.id,
      ocppConnectionName: station.ocppConnectionName,
      tenantId: invId,
    };
  });
}

/** List the chargers currently in inventory (platform staff only). */
export async function listInventoryAction(): Promise<
  ActionResult<Array<{ id: number; ocppConnectionName: string; serial: string | null; vendor: string | null; model: string | null; isOnline: boolean }>>
> {
  return authedAction(async (session) => {
    const roles = session.user.roles ?? [];
    if (!isPlatformAdmin(roles) && !roles.includes('platform-support')) {
      throw new Error('Platform staff only');
    }
    const invId = await inventoryTenantId();
    const data = await hasuraAdmin<{ ChargingStations: any[] }>(
      `query($tid: Int!) {
         ChargingStations(where: {tenantId: {_eq: $tid}}, order_by: {id: asc}) {
           id
           ocppConnectionName
           chargePointSerialNumber
           chargeBoxSerialNumber
           chargePointVendor
           chargePointModel
           isOnline
         }
       }`,
      { tid: invId },
    );
    return data.ChargingStations.map((s) => ({
      id: s.id,
      ocppConnectionName: s.ocppConnectionName,
      serial: s.chargePointSerialNumber ?? s.chargeBoxSerialNumber ?? null,
      vendor: s.chargePointVendor ?? null,
      model: s.chargePointModel ?? null,
      isOnline: !!s.isOnline,
    }));
  });
}
