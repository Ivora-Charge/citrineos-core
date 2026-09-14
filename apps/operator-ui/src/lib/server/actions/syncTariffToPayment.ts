// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use server';

import {
  authedActionWithRoles,
  resolveActingTenantId,
  ForbiddenError,
  type ActionResult,
} from '@lib/utils/action-guard';
import { MUTATING_ROLES } from '@lib/utils/csms-claims';
import config from '@lib/utils/config';

// Same audience as syncPaymentCatalogAction: tenant admins and platform staff.
const SYNC_ROLES = MUTATING_ROLES;
import { syncPaymentCatalogAction, type PaymentCatalogSyncResult } from './syncPaymentCatalog';
import {
  buildCatalogSyncEntries,
  normalizeConnectorTariff,
  type PaymentTariffInput,
  type StationEvseInput,
} from '@lib/utils/payment-catalog.client';
import { audit } from '@lib/server/audit';

// Everything needed to sync one tariff: its pricing, the tenant business
// profile (operator/location fields), and every station/EVSE whose connector is
// assigned this tariff. The nested Connectors filter narrows each station's
// connectors to the ones actually on this tariff.
const TARIFF_PAYMENT_SYNC_QUERY = `
  query TariffPaymentSync($tariffId: Int!, $tenantId: Int!) {
    Tariffs_by_pk(id: $tariffId) {
      id
      tenantId
      currency
      pricePerKwh
      pricePerMin
      pricePerSession
      authorizationAmount
      paymentFee
      taxRate
    }
    Tenants_by_pk(id: $tenantId) {
      name
      businessName
      businessAddress
      businessPostalCode
      businessCity
      businessState
      businessCountry
      countryCode
      stripeAccountId
    }
    ChargingStations(where: { tenantId: { _eq: $tenantId }, Connectors: { tenantId: { _eq: $tenantId }, tariffId: { _eq: $tariffId } } }) {
      ocppConnectionName
      Location {
        id
        tenantId
        name
        address
        city
        postalCode
        state
        country
      }
      evses: Evses(where: { tenantId: { _eq: $tenantId } }) {
        id
        evseTypeId
        evseId
      }
      connectors: Connectors(where: { tenantId: { _eq: $tenantId }, tariffId: { _eq: $tariffId } }) {
        evseId
        tariffId
        powerType
        maximumVoltage
        maximumAmperage
        maximumPowerWatts
      }
    }
  }
`;

interface TariffPaymentSyncData {
  Tariffs_by_pk: Record<string, unknown> | null;
  Tenants_by_pk: Record<string, string | null> | null;
  ChargingStations: Array<{
    ocppConnectionName: string;
    Location: {
      id: number;
      tenantId: number;
      name: string | null;
      address: string | null;
      city: string | null;
      postalCode: string | null;
      state: string | null;
      country: string | null;
    } | null;
    evses: Array<{ id: number; evseTypeId: number | null; evseId: number | null }>;
    connectors: Array<{
      evseId: number | null;
      tariffId: number | null;
      powerType: string | null;
      maximumVoltage: number | null;
      maximumAmperage: number | null;
      maximumPowerWatts: number | null;
    }>;
  }>;
}

/**
 * Push one tariff's pricing to the payment service for every EVSE whose
 * connector is assigned that tariff. Called automatically after a tariff is
 * saved (tariff.upsert) or assigned to a connector (connectors.upsert), so the
 * payment catalog no longer drifts until someone presses "Sync payments" in
 * Business settings.
 *
 * Queries Hasura server-side (same endpoint the UI uses) and reuses the
 * buildCatalogSyncEntries -> syncPaymentCatalogAction pipeline, which also
 * refreshes the charger's standing QR / display adapter on the payment side.
 *
 * Returns an empty list when no connector uses the tariff yet (e.g. right
 * after creating it) -- nothing to sync is not an error.
 */
export async function syncTariffToPaymentAction(
  tariffId: number,
  options?: { tenantIdOverride?: string },
): Promise<ActionResult<PaymentCatalogSyncResult[]>> {
  return authedActionWithRoles<PaymentCatalogSyncResult[]>(SYNC_ROLES, async (session) => {
    // Platform staff may sync on behalf of a tenant (e.g. right after claiming
    // a charger for them); the override is re-validated in
    // syncPaymentCatalogAction, but the Hasura reads here need it too. A
    // session with no tenant and no override is refused -- never tenant "1".
    const tenantId = resolveActingTenantId(session, options?.tenantIdOverride);
    if (!Number.isSafeInteger(tariffId) || tariffId <= 0) throw new ForbiddenError('Invalid tariff');

    const res = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.hasuraAdminSecret ? { 'x-hasura-admin-secret': config.hasuraAdminSecret } : {}),
      },
      body: JSON.stringify({
        query: TARIFF_PAYMENT_SYNC_QUERY,
        variables: { tariffId, tenantId: Number(tenantId) },
      }),
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`GraphQL request failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      data?: TariffPaymentSyncData;
      errors?: Array<{ message: string }>;
    };
    if (body.errors?.length) {
      throw new Error(`GraphQL error: ${body.errors[0].message}`);
    }
    const data = body.data;
    if (!data?.Tariffs_by_pk) {
      throw new ForbiddenError('Tariff is not available in this tenant');
    }
    if (Number(data.Tariffs_by_pk.tenantId) !== Number(tenantId)) {
      throw new ForbiddenError('Tariff is not available in this tenant');
    }

    const tenant = data.Tenants_by_pk;
    if (!tenant?.stripeAccountId) {
      throw new Error(
        'No Stripe account configured -- set it in Settings -> Business before syncing tariffs',
      );
    }

    // One entry per EVSE that has a connector on this tariff. Connector.evseId
    // is the Evse table id; the payment service wants the OCPP evse number,
    // which CitrineOS stores in evseTypeId (evseId column is often null).
    const evses: StationEvseInput[] = [];
    const seen = new Set<string>();
    const tariff = normalizeConnectorTariff(data.Tariffs_by_pk) as PaymentTariffInput;
    for (const station of data.ChargingStations) {
      if (station.Location && station.Location.tenantId !== Number(tenantId)) {
        throw new ForbiddenError('Station location is not available in this tenant');
      }
      const evseById = new Map(station.evses.map((e) => [Number(e.id), e]));
      for (const connector of station.connectors) {
        const evse = evseById.get(Number(connector.evseId));
        const ocppEvseId = Number(evse?.evseTypeId ?? evse?.evseId);
        if (!Number.isFinite(ocppEvseId)) continue;
        const key = `${station.ocppConnectionName}-${ocppEvseId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        evses.push({
          ocppConnectionName: station.ocppConnectionName,
          evseId: ocppEvseId,
          tariff,
          location: station.Location,
          connector,
        });
      }
    }
    if (evses.length === 0) {
      return [];
    }

    const business = {
      operatorName: tenant.businessName || tenant.name || 'Operator',
      stripeAccountId: tenant.stripeAccountId,
      address: tenant.businessAddress || '',
      postalCode: tenant.businessPostalCode || '',
      city: tenant.businessCity || '',
      state: tenant.businessState || '',
      country: tenant.businessCountry || tenant.countryCode || '',
    };
    const entries = buildCatalogSyncEntries(business, tariff, evses, `tenant-${tenantId}`);

    const result = await syncPaymentCatalogAction(entries, {
      // Pass the resolved tenant explicitly so platform staff acting on their
      // own home tenant resolve to the same tenant on the inner action.
      tenantIdOverride: tenantId,
    });
    if (!result.success) {
      throw new Error(result.error);
    }
    await audit({
      actor: session.user.email ?? session.user.name ?? 'unknown',
      actorRoles: session.user.roles,
      tenantId,
      action: 'payment.sync-tariff',
      target: `tariff ${tariffId}`,
      detail: {
        evses: entries.map((e) => e.evse_id),
        failed: result.data.filter((r) => !r.ok).map((r) => r.evse_id),
      },
    });
    return result.data;
  });
}
