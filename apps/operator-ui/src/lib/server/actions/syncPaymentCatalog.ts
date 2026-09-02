// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use server';

import {
  authedActionWithRoles,
  resolveActingTenantId,
  type ActionResult,
} from '@lib/utils/action-guard';
import { MUTATING_ROLES, PLATFORM_ROLES } from '@lib/utils/csms-claims';
import config from '@lib/utils/config';

// Who may push to the payment catalog: tenant admins (own tenant) and platform
// staff (any tenant, named explicitly). Read-only roles are refused.
const SYNC_ROLES: readonly string[] = [...new Set([...MUTATING_ROLES, ...PLATFORM_ROLES])];

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
    const url = `${baseUrl.replace(/\/$/, '')}/api/catalog/sync`;

    const results: PaymentCatalogSyncResult[] = [];
    for (const entry of entries) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Catalog-Sync-Secret': secret,
          },
          body: JSON.stringify({ ...entry, tenant_id: tenantId }),
          cache: 'no-store',
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
