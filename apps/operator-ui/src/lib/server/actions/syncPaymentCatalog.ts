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
import { hasuraAdmin } from '@lib/server/hasura';

// Who may push to the payment catalog: tenant admins (own tenant) and platform
// staff (any tenant, named explicitly). Read-only roles are refused.
const SYNC_ROLES = MUTATING_ROLES;

const CATALOG_OWNERSHIP_QUERY = `
  query CatalogOwnership($tenantId: Int!, $names: [String!]!) {
    Tenants_by_pk(id: $tenantId) {
      name businessName stripeAccountId businessAddress businessPostalCode
      businessCity businessState businessCountry countryCode
    }
    ChargingStations(where: {tenantId: {_eq: $tenantId}, ocppConnectionName: {_in: $names}}) {
      ocppConnectionName tenantId
      Location { id tenantId name address postalCode city state country }
      Evses(where: {tenantId: {_eq: $tenantId}}) { evseTypeId evseId }
    }
  }
`;

interface CatalogOwnership {
  Tenants_by_pk: Record<string, string | null> | null;
  ChargingStations: Array<{
    ocppConnectionName: string;
    tenantId: number;
    Location: ({ id: number; tenantId: number } & Record<string, any>) | null;
    Evses: Array<{ evseTypeId: number | null; evseId: number | null }>;
  }>;
}

// One operator -> location -> tariff -> evse -> connector chain to upsert.
// Mirrors CatalogSyncRequest in citrineos-payment/schemas/catalog.py. tenant_id
// is deliberately NOT part of this type: the server action stamps it from the
// authenticated session so a client cannot write into another tenant's catalog.
export interface PaymentCatalogSyncEntry {
  operator_name: string;
  stripe_account_id: string;
  location_id: string;
  address: string;
  postal_code: string;
  city: string;
  state: string;
  country: string;
  location_name?: string;
  station_id: string;
  ocpp_evse_id: number;
  evse_id: string;
  connector_id?: string;
  currency?: string;
  tax_rate?: number;
  authorization_amount?: number;
  price_kwh?: number;
  price_minute?: number;
  price_session?: number;
  payment_fee?: number;
  power_type?: 'AC_1_PHASE' | 'AC_3_PHASE' | 'DC';
  max_voltage?: number;
  max_amperage?: number;
  max_power_watts?: number;
}

export interface PaymentCatalogSyncResult {
  evse_id: string;
  ok: boolean;
  error?: string;
}

/**
 * POST each catalog entry to the payment service's /api/catalog/sync endpoint.
 *
 * The shared secret (PAYMENT_CATALOG_SYNC_SECRET) is read here, server-side
 * only, and sent in the X-Catalog-Sync-Secret header. tenant_id is forced from
 * the authenticated session. Returns a per-EVSE result list; a single failing
 * EVSE does not abort the others (the upsert is idempotent, so re-runs are safe).
 */
export async function syncPaymentCatalogAction(
  entries: PaymentCatalogSyncEntry[],
  options?: { tenantIdOverride?: string },
): Promise<ActionResult<PaymentCatalogSyncResult[]>> {
  return authedActionWithRoles<PaymentCatalogSyncResult[]>(SYNC_ROLES, async (session) => {
    const baseUrl = config.paymentServiceUrl;
    const secret = process.env.PAYMENT_CATALOG_SYNC_SECRET;

    if (!baseUrl) {
      throw new Error('NEXT_PUBLIC_PAYMENT_SERVICE_URL is not configured');
    }
    if (!secret) {
      throw new Error('PAYMENT_CATALOG_SYNC_SECRET is not configured');
    }

    // The tenant comes from the validated session (Supabase claims). Tenant
    // users are bound to their own tenant; platform staff may act on behalf
    // of a specific tenant (e.g. when claiming a charger for them) by naming
    // it. There is deliberately no fallback to config.tenantId: a session
    // without a tenant and without an explicit platform override is refused.
    const tenantId = resolveActingTenantId(session, options?.tenantIdOverride);
    if (!Array.isArray(entries) || entries.length > 500) throw new Error('Invalid catalog batch');
    if (!entries.length) return [];
    for (const entry of entries) {
      if (!entry || typeof entry.station_id !== 'string' || !entry.station_id ||
          !Number.isSafeInteger(entry.ocpp_evse_id) || entry.ocpp_evse_id < 0) {
        throw new ForbiddenError('Invalid catalog target');
      }
    }
    const ownership = await hasuraAdmin<CatalogOwnership>(CATALOG_OWNERSHIP_QUERY, {
      tenantId: Number(tenantId), names: [...new Set(entries.map((entry) => entry.station_id))],
    });
    const tenant = ownership.Tenants_by_pk;
    if (!tenant?.stripeAccountId) throw new Error('No Stripe account configured for this tenant');
    const stations = new Map(ownership.ChargingStations.map((station) => [station.ocppConnectionName, station]));
    // Validate the complete batch before the first external mutation. Every
    // identity and payment destination is then built from trusted database rows.
    const verifiedEntries = entries.map((entry): PaymentCatalogSyncEntry => {
      const station = stations.get(entry.station_id);
      if (!station || station.tenantId !== Number(tenantId) ||
          !station.Evses.some((evse) => Number(evse.evseTypeId ?? evse.evseId) === entry.ocpp_evse_id)) {
        throw new ForbiddenError('Catalog equipment is not available in this tenant');
      }
      const location = station.Location;
      if (location && location.tenantId !== Number(tenantId)) throw new ForbiddenError('Invalid station location');
      const evseId = `${station.ocppConnectionName}-${entry.ocpp_evse_id}`;
      const locationId = `tenant-${tenantId}${location ? `-loc-${location.id}` : ''}`;
      if (entry.evse_id !== evseId || entry.location_id !== locationId ||
          (entry.connector_id !== undefined && entry.connector_id !== `${evseId}-1`) ||
          entry.stripe_account_id !== tenant.stripeAccountId) {
        throw new ForbiddenError('Catalog identity does not match the tenant equipment');
      }
      return {
        operator_name: tenant.businessName || tenant.name || 'Operator',
        stripe_account_id: tenant.stripeAccountId,
        location_id: locationId,
        address: (location ? location.address : tenant.businessAddress) || '',
        postal_code: (location ? location.postalCode : tenant.businessPostalCode) || '',
        city: (location ? location.city : tenant.businessCity) || '',
        state: (location ? location.state : tenant.businessState) || '',
        country: (location ? location.country : tenant.businessCountry || tenant.countryCode) || '',
        ...(location?.name ? { location_name: location.name } : {}),
        station_id: station.ocppConnectionName,
        ocpp_evse_id: entry.ocpp_evse_id,
        evse_id: evseId,
        connector_id: `${evseId}-1`,
        currency: entry.currency,
        tax_rate: entry.tax_rate,
        authorization_amount: entry.authorization_amount,
        price_kwh: entry.price_kwh,
        price_minute: entry.price_minute,
        price_session: entry.price_session,
        payment_fee: entry.payment_fee,
        power_type: entry.power_type,
        max_voltage: entry.max_voltage,
        max_amperage: entry.max_amperage,
        max_power_watts: entry.max_power_watts,
      };
    });
    const url = `${baseUrl.replace(/\/$/, '')}/api/catalog/sync`;

    const results: PaymentCatalogSyncResult[] = [];
    for (const entry of verifiedEntries) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Catalog-Sync-Secret': secret,
          },
          body: JSON.stringify({ ...entry, tenant_id: tenantId }),
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          results.push({
            evse_id: entry.evse_id,
            ok: false,
            error: `HTTP ${res.status}: ${detail.slice(0, 200)}`,
          });
        } else {
          results.push({ evse_id: entry.evse_id, ok: true });
        }
      } catch (err) {
        results.push({
          evse_id: entry.evse_id,
          ok: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
    return results;
  });
}
