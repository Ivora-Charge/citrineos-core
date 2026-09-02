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

/** The CSMS Location assigned to a charging station (Edit charging station ->
 * Location). When present it becomes the payment-side location for the EVSE, so
 * the checkout page shows the site the operator assigned the charger to instead
 * of the tenant's billing address. */
export interface StationLocationInput {
  id: number;
  name?: string | null;
  address?: string | null;
  city?: string | null;
  postalCode?: string | null;
  state?: string | null;
  country?: string | null;
}

/** Nameplate specs from the CSMS Connectors row, if the charger reported /
 * the operator configured them. */
export interface StationConnectorSpecs {
  powerType?: string | null;
  maximumVoltage?: number | null;
  maximumAmperage?: number | null;
  maximumPowerWatts?: number | null;
}

/** Minimal EVSE shape we pull from CitrineOS to build sync entries. */
export interface StationEvseInput {
  /** CitrineOS ocppConnectionName -> payment station_id */
  ocppConnectionName: string;
  /** OCPP evseId reported by the station -> payment ocpp_evse_id */
  evseId: number;
  /**
   * Pricing from the Tariff assigned to this EVSE's connector, if any. Used in
   * preference to the form's default pricing so each EVSE is synced with the
   * tariff actually configured for it (a field left unset here falls back to the
   * default tariff). Without this, every EVSE was synced with the flat default.
   */
  tariff?: Partial<PaymentTariffInput>;
  /** The station's assigned CSMS location; falls back to the tenant business
   * address when the charger has no location yet. */
  location?: StationLocationInput | null;
  /** Connector nameplate specs; omitted fields keep the payment defaults. */
  connector?: StationConnectorSpecs | null;
}

/** A connector's Tariff as returned by the GraphQL API (decimal columns may be
 * strings/null). */
export interface ConnectorTariff {
  currency?: string | null;
  pricePerKwh?: number | string | null;
  pricePerMin?: number | string | null;
  pricePerSession?: number | string | null;
  authorizationAmount?: number | string | null;
  paymentFee?: number | string | null;
  taxRate?: number | string | null;
}

/**
 * Map a connector's GraphQL Tariff onto the payment tariff input shape. Null /
 * undefined columns are dropped so the default tariff fills those gaps in
 * buildCatalogSyncEntries.
 */
export const normalizeConnectorTariff = (
  tariff: ConnectorTariff | null | undefined,
): Partial<PaymentTariffInput> | undefined => {
  if (!tariff) return undefined;
  const num = (v: number | string | null | undefined): number | undefined => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const out: Partial<PaymentTariffInput> = {};
  if (tariff.currency) out.currency = tariff.currency;
  const priceKwh = num(tariff.pricePerKwh);
  if (priceKwh !== undefined) out.priceKwh = priceKwh;
  const priceMinute = num(tariff.pricePerMin);
  if (priceMinute !== undefined) out.priceMinute = priceMinute;
  const priceSession = num(tariff.pricePerSession);
  if (priceSession !== undefined) out.priceSession = priceSession;
  const authorizationAmount = num(tariff.authorizationAmount);
  if (authorizationAmount !== undefined) out.authorizationAmount = authorizationAmount;
  const paymentFee = num(tariff.paymentFee);
  if (paymentFee !== undefined) out.paymentFee = paymentFee;
  const taxRate = num(tariff.taxRate);
  if (taxRate !== undefined) out.taxRate = taxRate;
  return out;
};

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
  evses.map((evse) => {
    // Per-EVSE tariff (from its connector) wins; the form's default tariff fills
    // any field the assigned tariff leaves unset, and is the whole tariff when no
    // tariff is assigned to the connector.
    const effective = { ...tariff, ...evse.tariff };
    // The station's assigned CSMS location wins over the tenant business
    // address; each site gets its own payment location row (keyed off the CSMS
    // location id) so the checkout page shows where the charger actually is.
    const loc = evse.location;
    const specs = evse.connector;
    return {
      operator_name: business.operatorName,
      stripe_account_id: business.stripeAccountId,
      location_id: loc ? `${locationId}-loc-${loc.id}` : locationId,
      address: (loc ? loc.address : business.address) ?? '',
      postal_code: (loc ? loc.postalCode : business.postalCode) ?? '',
      city: (loc ? loc.city : business.city) ?? '',
      state: (loc ? loc.state : business.state) ?? '',
      country: (loc ? loc.country : business.country) ?? '',
      ...(loc?.name ? { location_name: loc.name } : {}),
      station_id: evse.ocppConnectionName,
      ocpp_evse_id: evse.evseId,
      evse_id: buildEvseId(evse.ocppConnectionName, evse.evseId),
      currency: effective.currency,
      tax_rate: effective.taxRate,
      authorization_amount: effective.authorizationAmount,
      price_kwh: effective.priceKwh,
      price_minute: effective.priceMinute,
      price_session: effective.priceSession,
      payment_fee: effective.paymentFee,
      // Connector nameplate specs: only sent when the CSMS actually has them,
      // so the payment-side defaults (and tri-state max_power_watts) hold
      // otherwise.
      ...(specs?.powerType ? { power_type: normalizePowerType(specs.powerType) } : {}),
      ...(specs?.maximumVoltage ? { max_voltage: Number(specs.maximumVoltage) } : {}),
      ...(specs?.maximumAmperage ? { max_amperage: Number(specs.maximumAmperage) } : {}),
      ...(specs?.maximumPowerWatts
        ? { max_power_watts: Number(specs.maximumPowerWatts) }
        : {}),
    };
  });

/** Invoke the server action that POSTs each entry to the payment service.
 * Pass the page's acting tenant id so platform staff working on behalf of a
 * tenant stamp that tenant (the server validates the override by role). */
export const syncPaymentCatalog = (entries: PaymentCatalogSyncEntry[], tenantId?: number) =>
  syncPaymentCatalogAction(
    entries,
    tenantId != null ? { tenantIdOverride: String(tenantId) } : undefined,
  );
