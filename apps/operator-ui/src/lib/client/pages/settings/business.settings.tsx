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
import Link from 'next/link';
import { toast } from 'sonner';
import { Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@lib/client/components/ui/button';
import { Card, CardContent, CardHeader } from '@lib/client/components/ui/card';
import { Input } from '@lib/client/components/ui/input';
import { FormField } from '@lib/client/components/form/field';
import { AccessDeniedFallback } from '@lib/utils/AccessDeniedFallback';
import { ActionType, ResourceType } from '@lib/utils/access.types';
import { heading2Style, heading3Style, pageMargin } from '@lib/client/styles/page';
import { cardGridStyle } from '@lib/client/styles/card';
import { useTenantId } from '@lib/client/hooks/useTenantId';
import { TENANT_EDIT_MUTATION, TENANT_GET_QUERY } from '@lib/queries/tenants';
import { CHARGING_STATIONS_LIST_QUERY } from '@lib/queries/charging.stations';
import {
  buildCatalogSyncEntries,
  syncPaymentCatalog,
  type StationEvseInput,
} from '@lib/utils/payment-catalog.client';

const stripeAccountIdSchema = z
  .string()
  .min(1, 'Required')
  .refine((v) => v === 'platform' || v.startsWith('acct_'), {
    message: 'Must be a Stripe account id (acct_…) or "platform" for dev',
  });

const BusinessSchema = z.object({
  businessName: z.string().min(1, 'Required'),
  businessAddress: z.string().min(1, 'Required'),
  businessPostalCode: z.string().optional().default(''),
  businessCity: z.string().optional().default(''),
  businessState: z.string().optional().default(''),
  businessCountry: z.string().optional().default(''),
  businessContactEmail: z.string().email('Invalid email').optional().or(z.literal('')),
  businessContactPhone: z.string().optional().default(''),
  stripeAccountId: stripeAccountIdSchema,
  // Default pricing pushed to the payment service on "Sync payments".
  currency: z.string().min(1, 'Required').max(3, '3-letter code'),
  priceKwh: z.coerce.number().min(0),
  priceMinute: z.coerce.number().min(0),
  priceSession: z.coerce.number().min(0),
  authorizationAmount: z.coerce.number().min(0),
  taxRate: z.coerce.number().min(0),
  paymentFee: z.coerce.number().min(0),
});

type BusinessForm = z.infer<typeof BusinessSchema>;

const defaults: BusinessForm = {
  businessName: '',
  businessAddress: '',
  businessPostalCode: '',
  businessCity: '',
  businessState: '',
  businessCountry: '',
  businessContactEmail: '',
  businessContactPhone: '',
  stripeAccountId: '',
  currency: 'usd',
  priceKwh: 0.3,
  priceMinute: 0,
  priceSession: 0,
  authorizationAmount: 25,
  taxRate: 0,
  paymentFee: 0,
};

const mask = (id: string | undefined): string => {
  if (!id) return '—';
  if (id === 'platform') return 'platform (dev)';
  if (id.length <= 8) return id;
  return `${id.slice(0, 5)}…${id.slice(-4)}`;
};

const mapTenant = (record: Record<string, unknown> | undefined): BusinessForm => {
  const str = (k: string) => (record?.[k] == null ? '' : String(record[k]));
  return {
    ...defaults,
    businessName: str('businessName') || str('name'),
    businessAddress: str('businessAddress'),
    businessPostalCode: str('businessPostalCode'),
    businessCity: str('businessCity'),
    businessState: str('businessState'),
    businessCountry: str('businessCountry') || str('countryCode'),
    businessContactEmail: str('businessContactEmail'),
    businessContactPhone: str('businessContactPhone'),
    stripeAccountId: str('stripeAccountId'),
  };
};

export const BusinessSettings = () => {
  const tenantId = useTenantId();
  const [syncing, setSyncing] = useState(false);

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
        // NOTE: select runs on every render -- it must be pure (no setState),
        // or React throws "too many re-renders" (#301). Map only.
        select: (data: GetOneResponse<any>) => ({ ...data, data: mapTenant(data.data) }),
      },
    },
    defaultValues: defaults,
    resolver: zodResolver(BusinessSchema),
  });

  const {
    query: { data: stationsData },
  } = useList<any>({
    resource: ResourceType.CHARGING_STATIONS,
    pagination: { mode: 'off' },
    meta: { gqlQuery: CHARGING_STATIONS_LIST_QUERY },
  });

  const evses: StationEvseInput[] = useMemo(() => {
    const stations = stationsData?.data ?? [];
    return stations.flatMap((s: any) =>
      (s.evses ?? []).map((e: any) => ({
        ocppConnectionName: s.ocppConnectionName as string,
        // CitrineOS stores the OCPP evse number in evseTypeId; evseId is often
        // null. See onboarding.wizard.tsx for the mapping rationale.
        evseId: Number(e.evseTypeId ?? e.evseId),
      })),
    ).filter((e: StationEvseInput) => Number.isFinite(e.evseId));
  }, [stationsData]);

  const save = form.handleSubmit(async (values: any) => {
    await form.refineCore.onFinish({
      businessName: values.businessName,
      businessAddress: values.businessAddress,
      businessPostalCode: values.businessPostalCode || null,
      businessCity: values.businessCity || null,
      businessState: values.businessState || null,
      businessCountry: values.businessCountry || null,
      businessContactEmail: values.businessContactEmail || null,
      businessContactPhone: values.businessContactPhone || null,
      stripeAccountId: values.stripeAccountId,
      updatedAt: new Date().toISOString(),
    } as any);
    toast.success('Business settings saved.');
  });

  const syncPayments = form.handleSubmit(async (values: any) => {
    if (evses.length === 0) {
      toast.warning('No EVSEs found to sync. Add a charging station first.');
      return;
    }
    setSyncing(true);
    try {
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
      const result = await syncPaymentCatalog(entries);
      if (!result.success) {
        toast.error(`Payment sync failed: ${result.error}`);
        return;
      }
      const failed = result.data.filter((r) => !r.ok);
      if (failed.length > 0) {
        toast.error(`${failed.length}/${result.data.length} EVSE(s) failed to sync.`);
      } else {
        toast.success(`Synced ${result.data.length} EVSE(s) to the payment service.`);
      }
    } finally {
      setSyncing(false);
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
          <h2 className={heading2Style}>Business information</h2>
          <p className="text-sm text-muted-foreground">
            Current Stripe account:{' '}
            <span className="font-mono">{mask(form.watch('stripeAccountId'))}</span>
          </p>
        </CardHeader>
        <CardContent>
          <FormProvider {...form}>
            <div className="flex flex-col gap-8 w-full">
              <section>
                <h3 className={heading3Style}>Business</h3>
                <div className={cardGridStyle}>
                  <FormField control={form.control} label="Legal / display name" name="businessName" required>
                    <Input />
                  </FormField>
                  <FormField control={form.control} label="Street address" name="businessAddress" required>
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
                    <Input />
                  </FormField>
                  <FormField control={form.control} label="Contact email" name="businessContactEmail">
                    <Input type="email" />
                  </FormField>
                  <FormField control={form.control} label="Contact phone" name="businessContactPhone">
                    <Input />
                  </FormField>
                </div>
              </section>

              <section>
                <h3 className={heading3Style}>Payment</h3>
                <div className="max-w-xl">
                  <FormField
                    control={form.control}
                    label="Stripe Connect account ID"
                    name="stripeAccountId"
                    required
                  >
                    <Input placeholder="acct_… or platform" />
                  </FormField>
                </div>
              </section>

              <section>
                <div className="flex items-center justify-between">
                  <h3 className={heading3Style}>Default pricing</h3>
                  <Link href="/tariffs" className="text-sm text-primary underline">
                    Manage tariffs →
                  </Link>
                </div>
                <p className="text-sm text-muted-foreground mb-2">
                  These values are pushed to the payment service when you sync.
                </p>
                <div className={cardGridStyle}>
                  <FormField control={form.control} label="Currency (3-letter)" name="currency" required>
                    <Input maxLength={3} />
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
                  <FormField control={form.control} label="Authorization amount" name="authorizationAmount">
                    <Input type="number" min="0" step="0.01" />
                  </FormField>
                  <FormField control={form.control} label="Tax rate" name="taxRate">
                    <Input type="number" min="0" step="0.0001" />
                  </FormField>
                  <FormField control={form.control} label="Payment fee" name="paymentFee">
                    <Input type="number" min="0" step="0.01" />
                  </FormField>
                </div>
              </section>

              <div className="flex items-center justify-end gap-4">
                <Button type="button" variant="outline" onClick={syncPayments} disabled={syncing}>
                  {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  Sync payments ({evses.length} EVSE{evses.length === 1 ? '' : 's'})
                </Button>
                <Button type="button" onClick={save} disabled={form.refineCore.formLoading}>
                  Save
                </Button>
              </div>
            </div>
          </FormProvider>
        </CardContent>
      </Card>
    </CanAccess>
  );
};
