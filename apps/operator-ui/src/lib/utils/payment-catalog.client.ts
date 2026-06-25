// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

// Client-side helpers for syncing the citrineos-payment catalog. The actual
// HTTP call is made server-side (see syncPaymentCatalog.ts) so the shared
// secret never reaches the browser. This module only builds request payloads
// and invokes the server action.

import {
  syncPaymentCatalogAction,
  type PaymentCatalogSyncEntry,
  type PaymentCatalogSyncResult,
} from '@lib/server/actions/syncPaymentCatalog';

export type { PaymentCatalogSyncEntry, PaymentCatalogSyncResult };

/** Tariff inputs collected in the onboarding wizard / settings page. */
export interface PaymentTariffInput {
  currency: string;
  taxRate: number;
  authorizationAmount: number;
  priceKwh: number;
  priceMinute: number;
  priceSession: number;
  paymentFee: number;
}

/** Business / location inputs (from the tenant business profile). */
export interface PaymentBusinessInput {
  operatorName: string;
  stripeAccountId: string;
  address: string;
  postalCode: string;
  city: string;
  state: string;
  country: string;
}

/** Minimal EVSE shape we pull from CitrineOS to build sync entries. */
export interface StationEvseInput {
  /** CitrineOS ocppConnectionName -> payment station_id */
  ocppConnectionName: string;
  /** OCPP evseId reported by the station -> payment ocpp_evse_id */
  evseId: number;
}

/**
 * EVSE business key convention shared with the payment service:
 *   {ocppConnectionName}-{evseId}
 * Keep this in lockstep with citrineos-payment (catalog/sync.py).
 */
export const buildEvseId = (ocppConnectionName: string, evseId: number): string =>
  `${ocppConnectionName}-${evseId}`;

/** Normalize CitrineOS power types to the payment ConnectorPowerType enum. */
export const normalizePowerType = (
  raw: string | null | undefined,
): 'AC_1_PHASE' | 'AC_3_PHASE' | 'DC' => {
  switch ((raw ?? '').toUpperCase()) {
    case 'DC':
      return 'DC';
    case 'AC_3_PHASE':
      return 'AC_3_PHASE';
    case 'AC':
    case 'AC_1_PHASE':
    default:
      return 'AC_1_PHASE';
  }
};

/**
 * Build one sync entry per EVSE. tenant_id is intentionally omitted here -- the
 * server action stamps it from the authenticated session so a client cannot
 * write into another tenant's catalog.
 */
export const buildCatalogSyncEntries = (
  business: PaymentBusinessInput,
  tariff: PaymentTariffInput,
  evses: StationEvseInput[],
  locationId: string,
): PaymentCatalogSyncEntry[] =>
  evses.map((evse) => ({
    operator_name: business.operatorName,
    stripe_account_id: business.stripeAccountId,
    location_id: locationId,
    address: business.address,
    postal_code: business.postalCode,
    city: business.city,
    state: business.state,
    country: business.country,
    station_id: evse.ocppConnectionName,
    ocpp_evse_id: evse.evseId,
    evse_id: buildEvseId(evse.ocppConnectionName, evse.evseId),
    currency: tariff.currency,
    tax_rate: tariff.taxRate,
    authorization_amount: tariff.authorizationAmount,
    price_kwh: tariff.priceKwh,
    price_minute: tariff.priceMinute,
    price_session: tariff.priceSession,
    payment_fee: tariff.paymentFee,
  }));

/** Invoke the server action that POSTs each entry to the payment service. */
export const syncPaymentCatalog = (entries: PaymentCatalogSyncEntry[]) =>
  syncPaymentCatalogAction(entries);
