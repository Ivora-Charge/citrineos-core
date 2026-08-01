// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import React, { useMemo, useState } from 'react';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { FormProvider } from 'react-hook-form';
import { useForm } from '@refinedev/react-hook-form';
import { CanAccess, type GetOneResponse, useList } from '@refinedev/core';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

import { Button } from '@lib/client/components/ui/button';
import { Card, CardContent, CardHeader } from '@lib/client/components/ui/card';
import { Input } from '@lib/client/components/ui/input';
import { FormField } from '@lib/client/components/form/field';
import { AccessDeniedFallback } from '@lib/utils/AccessDeniedFallback';
import { ActionType, ResourceType } from '@lib/utils/access.types';
import { heading2Style, pageMargin } from '@lib/client/styles/page';
import { cardGridStyle } from '@lib/client/styles/card';
import { useTenantId } from '@lib/client/hooks/useTenantId';
import { TENANT_EDIT_MUTATION, TENANT_GET_QUERY } from '@lib/queries/tenants';
import { CHARGING_STATIONS_LIST_QUERY } from '@lib/queries/charging.stations';
import {
  buildCatalogSyncEntries,
  normalizeConnectorTariff,
  syncPaymentCatalog,
  type StationEvseInput,
} from '@lib/utils/payment-catalog.client';
import {
  createStripeOnboardingLinkAction,
  getStripeConnectStatusAction,
  type ConnectStatus,
} from '@lib/server/actions/stripeConnect';
import { claimChargerAction } from '@lib/server/actions/claimCharger';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const stripeAccountIdSchema = z
  .string()
  .min(1, 'Required')
  .refine((v) => v === 'platform' || v.startsWith('acct_'), {
    message: 'Must be a Stripe account id (acct_…) or "platform" for dev',
  });

const OnboardingSchema = z.object({
  // Tenant profile
  name: z.string().min(1, 'Required'),
  countryCode: z.string().optional().default(''),
  partyId: z.string().optional().default(''),
  url: z.string().optional().default(''),
  // Business info
  businessName: z.string().min(1, 'Required'),
  businessAddress: z.string().min(1, 'Required'),
  businessPostalCode: z.string().optional().default(''),
  businessCity: z.string().optional().default(''),
  businessState: z.string().optional().default(''),
  businessCountry: z.string().optional().default(''),
  businessContactEmail: z.string().email('Invalid email').optional().or(z.literal('')),
  businessContactPhone: z.string().optional().default(''),
  // Payment
  stripeAccountId: stripeAccountIdSchema,
  // Default tariff
  currency: z.string().min(1, 'Required').max(3, '3-letter code'),
  priceKwh: z.coerce.number().min(0),
  priceMinute: z.coerce.number().min(0),
  priceSession: z.coerce.number().min(0),
  authorizationAmount: z.coerce.number().min(0),
  taxRate: z.coerce.number().min(0),
  paymentFee: z.coerce.number().min(0),
});

type OnboardingForm = z.infer<typeof OnboardingSchema>;

const tariffDefaults = {
  currency: 'usd',
  priceKwh: 0.3,
  priceMinute: 0,
  priceSession: 0,
  authorizationAmount: 25,
  taxRate: 0,
  paymentFee: 0,
};

const defaultValues: OnboardingForm = {
  name: '',
  countryCode: '',
  partyId: '',
  url: '',
  businessName: '',
  businessAddress: '',
  businessPostalCode: '',
  businessCity: '',
  businessState: '',
  businessCountry: '',
  businessContactEmail: '',
  businessContactPhone: '',
  stripeAccountId: '',
  ...tariffDefaults,
};

// Field groups validated before advancing each step. Stripe comes before the
// business step so its public profile can prefill the business fields.
const STEP_FIELDS: (keyof OnboardingForm)[][] = [
  ['name', 'countryCode', 'partyId', 'url'],
  ['stripeAccountId'],
  [
    'businessName',
    'businessAddress',
    'businessPostalCode',
    'businessCity',
    'businessState',
    'businessCountry',
    'businessContactEmail',
    'businessContactPhone',
  ],
  [], // claim chargers -- optional, nothing to validate
  [
    'currency',
    'priceKwh',
    'priceMinute',
    'priceSession',
    'authorizationAmount',
    'taxRate',
    'paymentFee',
  ],
  [],
];

const STEP_TITLES = [
  'Tenant profile',
  'Connect Stripe',
  'Business information',
  'Claim chargers',
  'Default tariff',
  'Review & complete',
];

// Normalize a fetched tenant record to form values, injecting tariff defaults
// (tariff fields are not stored on the tenant -- they go to the payment service).
const mapTenantToForm = (record: Record<string, unknown> | undefined): OnboardingForm => {
  const str = (k: string) => (record?.[k] == null ? '' : String(record[k]));
  const num = (k: string, fallback: number) =>
    record?.[k] == null || record[k] === '' ? fallback : Number(record[k]);
  return {
    ...defaultValues,
    name: str('name'),
    countryCode: str('countryCode'),
    partyId: str('partyId'),
    url: str('url'),
    businessName: str('businessName') || str('name'),
    businessAddress: str('businessAddress'),
    businessPostalCode: str('businessPostalCode'),
    businessCity: str('businessCity'),
    businessState: str('businessState'),
    businessCountry: str('businessCountry') || str('countryCode'),
    businessContactEmail: str('businessContactEmail'),
    businessContactPhone: str('businessContactPhone'),
    stripeAccountId: str('stripeAccountId'),
    // Default pricing persisted on the tenant row (Phase 6); the hardcoded
    // tariffDefaults only seed brand-new tenants.
    currency: str('defaultCurrency') || tariffDefaults.currency,
    priceKwh: num('defaultPriceKwh', tariffDefaults.priceKwh),
    priceMinute: num('defaultPriceMinute', tariffDefaults.priceMinute),
    priceSession: num('defaultPriceSession', tariffDefaults.priceSession),
    authorizationAmount: num('defaultAuthorizationAmount', tariffDefaults.authorizationAmount),
    taxRate: num('defaultTaxRate', tariffDefaults.taxRate),
    paymentFee: num('defaultPaymentFee', tariffDefaults.paymentFee),
  };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const OnboardingWizard = () => {
  const tenantId = useTenantId();
  const { replace } = useRouter();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Stripe Connect (Phase 5/6): hosted onboarding + live status. The account
  // id is written to the tenant row server-side when the account is created;
  // mirror it into the form so validation and the review step see it.
  const [connectStatus, setConnectStatus] = useState<ConnectStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const refreshConnectStatus = React.useCallback(async () => {
    const res = await getStripeConnectStatusAction(tenantId);
    if (res.success) {
      setConnectStatus(res.data);
      if (res.data.stripe_account_id?.startsWith('acct_')) {
        form.setValue('stripeAccountId', res.data.stripe_account_id, { shouldValidate: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);
  React.useEffect(() => {
    void refreshConnectStatus();
  }, [refreshConnectStatus]);

  const startStripeOnboarding = async () => {
    setConnecting(true);
    try {
      const res = await createStripeOnboardingLinkAction(tenantId);
      if (!res.success) {
        toast.error(`Stripe onboarding failed: ${res.error}`);
        return;
      }
      window.location.href = res.data.url;
    } finally {
      setConnecting(false);
    }
  };

  // Claim chargers (Phase 4/6).
  const [serial, setSerial] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState<string[]>([]);
  const claim = async () => {
    if (!serial.trim()) {
      toast.error('Enter the serial number printed on the charger');
      return;
    }
    setClaiming(true);
    try {
      const res = await claimChargerAction({ serial: serial.trim(), targetTenantId: tenantId });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success(`Charger ${res.data.ocppConnectionName} claimed.`);
      setClaimed((c) => [...c, res.data.ocppConnectionName]);
      setSerial('');
    } finally {
      setClaiming(false);
    }
  };

  const form = useForm({
    refineCoreProps: {
      resource: ResourceType.TENANTS,
      id: tenantId,
      action: 'edit',
      redirect: false,
      mutationMode: 'pessimistic',
      // We show our own toasts; the default notification translates a
      // Tenants resource label that has no i18n key.
      successNotification: false,
      meta: {
        gqlQuery: TENANT_GET_QUERY,
        gqlMutation: TENANT_EDIT_MUTATION,
      },
      queryOptions: {
        select: (data: GetOneResponse<any>) => ({
          ...data,
          data: mapTenantToForm(data.data),
        }),
      },
    },
    defaultValues,
    resolver: zodResolver(OnboardingSchema),
  });

  // Prefill business fields from the Stripe account's public profile so the
  // tenant doesn't re-type what Stripe already collected. Fill-if-empty only
  // (a saved tenant record or the user's own edits always win), and re-run
  // once the tenant record has loaded: refine resets the form when the query
  // resolves, which would clobber values applied too early.
  const connectProfile = connectStatus?.profile;
  const formLoading = form.refineCore.formLoading;
  React.useEffect(() => {
    if (!connectProfile || formLoading) return;
    const fill = (name: keyof OnboardingForm, value?: string | null) => {
      if (value && !form.getValues(name)) {
        form.setValue(name, value, { shouldDirty: true });
      }
    };
    fill('businessName', connectProfile.business_name);
    fill(
      'businessAddress',
      [connectProfile.address_line1, connectProfile.address_line2].filter(Boolean).join(', '),
    );
    fill('businessPostalCode', connectProfile.address_postal_code);
    fill('businessCity', connectProfile.address_city);
    fill('businessState', connectProfile.address_state);
    fill('businessCountry', connectProfile.address_country || connectProfile.country);
    fill('businessContactEmail', connectProfile.support_email || connectProfile.email);
    fill('businessContactPhone', connectProfile.support_phone);
    fill('url', connectProfile.url);
    if (connectProfile.default_currency && form.getValues('currency') === tariffDefaults.currency) {
      form.setValue('currency', connectProfile.default_currency);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectProfile, formLoading]);

  // All EVSEs across the tenant's charging stations -> payment sync entries.
  const {
    query: { data: stationsData },
  } = useList<any>({
    resource: ResourceType.CHARGING_STATIONS,
    pagination: { mode: 'off' },
    meta: { gqlQuery: CHARGING_STATIONS_LIST_QUERY },
  });

  const evses: StationEvseInput[] = useMemo(() => {
    const stations = stationsData?.data ?? [];
    return stations
      .flatMap((s: any) => {
        // Connector.evseId is the Evse table id; map each Evse to the Tariff on its
        // connector so the sync uses the EVSE's configured tariff rather than the
        // flat default pricing.
        const tariffByEvseDbId = new Map<number, any>();
        for (const c of s.connectors ?? []) {
          if (c?.evseId != null && c.Tariff) {
            tariffByEvseDbId.set(Number(c.evseId), c.Tariff);
          }
        }
        return (s.evses ?? []).map((e: any) => ({
          ocppConnectionName: s.ocppConnectionName as string,
          // CitrineOS stores the OCPP evse number in evseTypeId; the evseId column
          // is often null. evseTypeId is what maps to payment ocpp_evse_id and the
          // seed convention "{station}-{evseTypeId}".
          evseId: Number(e.evseTypeId ?? e.evseId),
          tariff: normalizeConnectorTariff(tariffByEvseDbId.get(Number(e.id))),
        }));
      })
      .filter((e: StationEvseInput) => Number.isFinite(e.evseId));
  }, [stationsData]);

  const next = async () => {
    const valid = await form.trigger(STEP_FIELDS[step] as any);
    if (valid) setStep((s) => Math.min(s + 1, STEP_TITLES.length - 1));
  };
  const prev = () => setStep((s) => Math.max(s - 1, 0));

  const complete = form.handleSubmit(async (values: any) => {
    setSubmitting(true);
    try {
      // 1. Persist tenant profile + business + payment fields, mark onboarded.
      // Cast to any: onFinish is typed to the form fields, but we also write
      // server-managed columns (paymentOnboardingCompletedAt, updatedAt). This
      // mirrors how tariff/locations upsert pass their serialized objects.
      await form.refineCore.onFinish({
        name: values.name,
        url: values.url || null,
        countryCode: values.countryCode || null,
        partyId: values.partyId || null,
        businessName: values.businessName,
        businessAddress: values.businessAddress,
        businessPostalCode: values.businessPostalCode || null,
        businessCity: values.businessCity || null,
        businessState: values.businessState || null,
        businessCountry: values.businessCountry || null,
        businessContactEmail: values.businessContactEmail || null,
        businessContactPhone: values.businessContactPhone || null,
        stripeAccountId: values.stripeAccountId,
        // Default pricing lives on the tenant row (Phase 6) so future flows
        // (claims, server-side syncs) can price new chargers without a
        // browser session holding the values.
        defaultCurrency: values.currency,
        defaultPriceKwh: values.priceKwh,
        defaultPriceMinute: values.priceMinute,
        defaultPriceSession: values.priceSession,
        defaultAuthorizationAmount: values.authorizationAmount,
        defaultTaxRate: values.taxRate,
        defaultPaymentFee: values.paymentFee,
        paymentOnboardingCompletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any);

      // 2. Push the catalog to the payment service (one entry per EVSE).
      if (evses.length === 0) {
        toast.warning(
          'Onboarding saved, but no EVSEs were found to sync. Add a charging station, then re-run "Sync payments" in Business settings.',
        );
      } else {
        const entries = buildCatalogSyncEntries(
          {
            operatorName: values.businessName,
            stripeAccountId: values.stripeAccountId,
            address: values.businessAddress,
            postalCode: values.businessPostalCode,
            city: values.businessCity,
            state: values.businessState,
            country: values.businessCountry,
          },
          {
            currency: values.currency,
            taxRate: values.taxRate,
            authorizationAmount: values.authorizationAmount,
            priceKwh: values.priceKwh,
            priceMinute: values.priceMinute,
            priceSession: values.priceSession,
            paymentFee: values.paymentFee,
          },
          evses,
          `tenant-${tenantId}`,
        );
        const result = await syncPaymentCatalog(entries, tenantId);
        if (!result.success) {
          toast.error(`Payment sync failed: ${result.error}`);
          setSubmitting(false);
          return;
        }
        const failed = result.data.filter((r) => !r.ok);
        if (failed.length > 0) {
          toast.error(
            `Onboarding saved, but ${failed.length}/${result.data.length} EVSE(s) failed to sync. Retry from Business settings.`,
          );
        } else {
          toast.success(`Payments enabled for ${result.data.length} EVSE(s).`);
        }
      }

      replace('/overview');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Onboarding failed');
      setSubmitting(false);
    }
  });

  return (
    <CanAccess
      resource={ResourceType.TENANTS}
      action={ActionType.EDIT}
      fallback={<AccessDeniedFallback />}
    >
      <Card className={pageMargin}>
        <CardHeader>
          <h2 className={heading2Style}>Get started</h2>
          {/* Stepper */}
          <ol className="flex flex-wrap gap-2 mt-4">
            {STEP_TITLES.map((title, i) => (
              <li
                key={title}
                className={`flex items-center gap-2 text-sm rounded-md px-3 py-1.5 ${
                  i === step
                    ? 'bg-accent text-accent-foreground font-medium'
                    : i < step
                      ? 'text-muted-foreground'
                      : 'text-muted-foreground/60'
                }`}
              >
                <span className="flex items-center justify-center size-5 rounded-full border text-xs">
                  {i < step ? <Check className="size-3" /> : i + 1}
                </span>
                {title}
              </li>
            ))}
          </ol>
        </CardHeader>
        <CardContent>
          <FormProvider {...form}>
            <div className="flex flex-col gap-6 w-full">
              {step === 0 && (
                <div className={cardGridStyle}>
                  <FormField control={form.control} label="Tenant name" name="name" required>
                    <Input />
                  </FormField>
                  <FormField control={form.control} label="Country code" name="countryCode">
                    <Input placeholder="e.g. US" maxLength={2} />
                  </FormField>
                  <FormField control={form.control} label="Party ID" name="partyId">
                    <Input placeholder="e.g. CPO" />
                  </FormField>
                  <FormField control={form.control} label="URL" name="url">
                    <Input placeholder="https://…" />
                  </FormField>
                </div>
              )}

              {step === 2 && (
                <div className="flex flex-col gap-4">
                  <p className="text-sm text-muted-foreground">
                    Prefilled from your Stripe account where available — please confirm or correct.
                    The address is shown to drivers as the charging site location, so change it if
                    your chargers aren&apos;t at your business address.
                  </p>
                  <div className={cardGridStyle}>
                    <FormField
                      control={form.control}
                      label="Legal / display name"
                      name="businessName"
                      required
                    >
                      <Input />
                    </FormField>
                    <FormField
                      control={form.control}
                      label="Street address"
                      name="businessAddress"
                      required
                    >
                      <Input />
                    </FormField>
                    <FormField control={form.control} label="Postal code" name="businessPostalCode">
                      <Input />
                    </FormField>
                    <FormField control={form.control} label="City" name="businessCity">
                      <Input />
                    </FormField>
                    <FormField control={form.control} label="State / Province" name="businessState">
                      <Input />
                    </FormField>
                    <FormField control={form.control} label="Country" name="businessCountry">
                      <Input placeholder="e.g. USA" />
                    </FormField>
                    <FormField
                      control={form.control}
                      label="Contact email"
                      name="businessContactEmail"
                    >
                      <Input type="email" />
                    </FormField>
                    <FormField
                      control={form.control}
                      label="Contact phone"
                      name="businessContactPhone"
                    >
                      <Input />
                    </FormField>
                  </div>
                </div>
              )}

              {step === 1 && (
                <div className="flex flex-col gap-4 max-w-xl">
                  <div className="flex items-center gap-3">
                    <Button
                      type="button"
                      onClick={startStripeOnboarding}
                      disabled={connecting || submitting}
                    >
                      {connecting && <Loader2 className="size-4 animate-spin" />}
                      {connectStatus?.stripe_account_id?.startsWith('acct_')
                        ? 'Continue Stripe onboarding'
                        : 'Connect with Stripe'}
                    </Button>
                    {connectStatus && (
                      <span className="text-sm text-muted-foreground">
                        {connectStatus.charges_enabled
                          ? '✓ Stripe account active — payments enabled'
                          : (connectStatus.requirements_due?.length ?? 0) > 0
                            ? `Action needed in Stripe: ${connectStatus
                                .requirements_due!.map((r) =>
                                  r.split('.').pop()?.replace(/_/g, ' '),
                                )
                                .join(', ')}`
                            : connectStatus.details_submitted
                              ? 'Details submitted — Stripe is reviewing'
                              : connectStatus.stripe_account_id?.startsWith('acct_')
                                ? 'Onboarding not finished'
                                : 'No Stripe account connected yet'}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Stripe walks you through identity and payout details; you&apos;ll return here
                    afterwards. You can keep going with the rest of the setup while Stripe finishes
                    — payments switch on the moment the account is active.
                  </p>
                  <FormField
                    control={form.control}
                    label="Stripe Connect account ID (manual override)"
                    name="stripeAccountId"
                    required
                  >
                    <Input placeholder="acct_… or platform" />
                  </FormField>
                </div>
              )}

              {step === 3 && (
                <div className="flex flex-col gap-4 max-w-xl">
                  <p className="text-sm text-muted-foreground">
                    Claim the chargers you purchased by the serial number printed on each unit. You
                    can also do this later from the Charging Stations page.
                  </p>
                  <div className="flex items-center gap-2">
                    <Input
                      className="w-64"
                      placeholder="Serial number (or station id)"
                      value={serial}
                      onChange={(e) => setSerial(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && void claim()}
                    />
                    <Button type="button" onClick={() => void claim()} disabled={claiming}>
                      {claiming && <Loader2 className="size-4 animate-spin" />}
                      Claim
                    </Button>
                  </div>
                  {claimed.length > 0 && (
                    <p className="text-sm">
                      Claimed in this session:{' '}
                      <span className="font-mono">{claimed.join(', ')}</span>
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground">
                    {evses.length > 0
                      ? `${evses.length} EVSE(s) currently in your fleet.`
                      : 'No chargers in your fleet yet.'}
                  </p>
                </div>
              )}

              {step === 4 && (
                <div className={cardGridStyle}>
                  <FormField
                    control={form.control}
                    label="Currency (3-letter)"
                    name="currency"
                    required
                  >
                    <Input placeholder="usd" maxLength={3} />
                  </FormField>
                  <FormField control={form.control} label="Price per kWh" name="priceKwh" required>
                    <Input type="number" min="0" step="0.01" />
                  </FormField>
                  <FormField control={form.control} label="Price per minute" name="priceMinute">
                    <Input type="number" min="0" step="0.01" />
                  </FormField>
                  <FormField control={form.control} label="Price per session" name="priceSession">
                    <Input type="number" min="0" step="0.01" />
                  </FormField>
                  <FormField
                    control={form.control}
                    label="Authorization amount"
                    name="authorizationAmount"
                  >
                    <Input type="number" min="0" step="0.01" />
                  </FormField>
                  <FormField control={form.control} label="Tax rate" name="taxRate">
                    <Input type="number" min="0" step="0.0001" />
                  </FormField>
                  <FormField control={form.control} label="Payment fee" name="paymentFee">
                    <Input type="number" min="0" step="0.01" />
                  </FormField>
                </div>
              )}

              {step === 5 && (
                <ReviewStep values={form.getValues() as OnboardingForm} evseCount={evses.length} />
              )}

              {/* Navigation */}
              <div className="flex items-center justify-between gap-4 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={prev}
                  disabled={step === 0 || submitting}
                >
                  <ChevronLeft className="size-4" /> Back
                </Button>
                {step < STEP_TITLES.length - 1 ? (
                  <Button type="button" onClick={next}>
                    Next <ChevronRight className="size-4" />
                  </Button>
                ) : (
                  <Button type="button" onClick={complete} disabled={submitting}>
                    {submitting && <Loader2 className="size-4 animate-spin" />}
                    Complete & enable payments
                  </Button>
                )}
              </div>
            </div>
          </FormProvider>
        </CardContent>
      </Card>
    </CanAccess>
  );
};

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex justify-between gap-4 py-1 border-b border-border/50 text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-medium text-right">{value || '—'}</span>
  </div>
);

const ReviewStep = ({ values, evseCount }: { values: OnboardingForm; evseCount: number }) => (
  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1 max-w-3xl">
    <Row label="Tenant name" value={values.name} />
    <Row
      label="Country / Party"
      value={`${values.countryCode || '—'} / ${values.partyId || '—'}`}
    />
    <Row label="Business name" value={values.businessName} />
    <Row label="Address" value={values.businessAddress} />
    <Row
      label="City / Postal"
      value={`${values.businessCity || '—'} ${values.businessPostalCode || ''}`}
    />
    <Row label="Contact" value={values.businessContactEmail} />
    <Row label="Stripe account" value={values.stripeAccountId} />
    <Row label="Currency" value={values.currency?.toUpperCase()} />
    <Row label="Price / kWh" value={values.priceKwh} />
    <Row label="Authorization amount" value={values.authorizationAmount} />
    <Row label="Tax rate / Fee" value={`${values.taxRate} / ${values.paymentFee}`} />
    <Row label="EVSEs to sync" value={evseCount} />
  </div>
);
