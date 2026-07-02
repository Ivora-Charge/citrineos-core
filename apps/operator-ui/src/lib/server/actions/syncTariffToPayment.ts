// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use server';

import { authedAction, type ActionResult } from '@lib/utils/action-guard';
import config from '@lib/utils/config';
import {
  syncPaymentCatalogAction,
  type PaymentCatalogSyncResult,
} from './syncPaymentCatalog';
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
    ChargingStations(where: { Connectors: { tariffId: { _eq: $tariffId } } }) {
      ocppConnectionName
      evses: Evses {
        id
        evseTypeId
        evseId
      }
      connectors: Connectors(where: { tariffId: { _eq: $tariffId } }) {
        evseId
        tariffId
      }
    }
  }
`;

interface TariffPaymentSyncData {
  Tariffs_by_pk: Record<string, unknown> | null;
  Tenants_by_pk: Record<string, string | null> | null;
  ChargingStations: Array<{
    ocppConnectionName: string;
    evses: Array<{ id: number; evseTypeId: number | null; evseId: number | null }>;
    connectors: Array<{ evseId: number | null; tariffId: number | null }>;
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
  return authedAction<PaymentCatalogSyncResult[]>(async (session) => {
    // Platform staff may sync on behalf of a tenant (e.g. right after claiming
    // a charger for them); the override is re-validated in
    // syncPaymentCatalogAction, but the Hasura reads here need it too.
    let tenantId = session.user.tenantId || config.tenantId;
    if (options?.tenantIdOverride) {
      const roles = session.user.roles ?? [];
      if (!roles.includes('platform-admin') && !roles.includes('admin')) {
        throw new Error('Only platform staff can sync on behalf of another tenant');
      }
      tenantId = options.tenantIdOverride;
    }

    const res = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.hasuraAdminSecret
          ? { 'x-hasura-admin-secret': config.hasuraAdminSecret }
          : {}),
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
      throw new Error(`Tariff ${tariffId} not found`);
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
      tenantIdOverride: options?.tenantIdOverride,
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
