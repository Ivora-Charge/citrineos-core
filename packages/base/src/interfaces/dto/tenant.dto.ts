// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { ServerProfileSchema } from './types/ocpi.registration.js';

export const TenantSchema = z.object({
  id: z.number().int().optional(),
  name: z.string(),
  url: z.string().nullable().optional(),
  countryCode: z.string().nullable().optional(),
  partyId: z.string().nullable().optional(),
  serverProfileOCPI: ServerProfileSchema.nullable().optional(),
  isUserTenant: z.boolean().default(false),
  maxChargingStations: z.number().int().nullable().optional(),
  // Business / payment onboarding fields. All nullable -- a tenant is created
  // before onboarding and these are filled in by the operator-ui onboarding
  // wizard (see apps/operator-ui onboarding flow). stripeAccountId accepts a
  // Stripe Connect account id ("acct_...") or the literal "platform" for dev.
  stripeAccountId: z.string().nullable().optional(),
  businessName: z.string().nullable().optional(),
  businessAddress: z.string().nullable().optional(),
  businessPostalCode: z.string().nullable().optional(),
  businessCity: z.string().nullable().optional(),
  businessState: z.string().nullable().optional(),
  businessCountry: z.string().nullable().optional(),
  businessContactEmail: z.string().nullable().optional(),
  businessContactPhone: z.string().nullable().optional(),
  // Set when the operator finishes the onboarding wizard; the operator-ui nav
  // gate keys off this being non-null.
  paymentOnboardingCompletedAt: z.coerce.date().nullable().optional(),
  updatedAt: z.date().optional(),
  createdAt: z.date().optional(),
});

export const TenantProps = TenantSchema.keyof().enum;

export type TenantDto = z.infer<typeof TenantSchema>;

export const TenantCreateSchema = TenantSchema.omit({
  id: true,
  updatedAt: true,
  createdAt: true,
});

export type TenantCreate = z.infer<typeof TenantCreateSchema>;

export const TenantUpdateSchema = TenantSchema.partial().omit({
  updatedAt: true,
  createdAt: true,
});

export type TenantUpdate = z.infer<typeof TenantUpdateSchema>;

export const tenantSchemas = {
  Tenant: TenantSchema,
  TenantCreate: TenantCreateSchema,
  TenantUpdate: TenantUpdateSchema,
};
