// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use server';

import { authedAction, type ActionResult } from '@lib/utils/action-guard';
import config from '@lib/utils/config';
import { audit } from '@lib/server/audit';

// Stripe Connect onboarding (multi-tenant rollout Phase 5). The Stripe
// platform key lives in the payment service; these actions proxy to its
// service-to-service /api/connect endpoints with the shared secret and
// enforce that a tenant user can only onboard their own tenant.

// Public-profile fields of the connected account (business_profile is all a
// platform can read on a Standard account, and every field in it is optional
// in Stripe onboarding) -- used to prefill the business-information step.
export interface ConnectProfile {
  business_name?: string | null;
  url?: string | null;
  support_email?: string | null;
  support_phone?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  address_city?: string | null;
  address_state?: string | null;
  address_postal_code?: string | null;
  address_country?: string | null;
  email?: string | null;
  country?: string | null;
  default_currency?: string | null;
}

export interface ConnectStatus {
  stripe_account_id?: string | null;
  charges_enabled: boolean;
  details_submitted: boolean;
  disabled_reason?: string | null;
  requirements_due?: string[];
  profile?: ConnectProfile | null;
}

const isPlatformAdmin = (roles: string[]) =>
  roles.includes('platform-admin') || roles.includes('admin');

async function paymentApi(path: string, init?: RequestInit) {
  const baseUrl = config.paymentServiceUrl;
  const secret = process.env.PAYMENT_CATALOG_SYNC_SECRET;
  if (!baseUrl) throw new Error('NEXT_PUBLIC_PAYMENT_SERVICE_URL is not configured');
  if (!secret) throw new Error('PAYMENT_CATALOG_SYNC_SECRET is not configured');
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/connect${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Catalog-Sync-Secret': secret,
      ...init?.headers,
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Payment service: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json();
}

function resolveTenant(session: any, requested?: number): number {
  const roles: string[] = session.user.roles ?? [];
  const own = Number(session.user.tenantId);
  if (isPlatformAdmin(roles)) {
    return requested ?? own ?? Number(config.tenantId);
  }
  if (!roles.includes('tenant-admin')) {
    throw new Error('Only tenant or platform admins can manage Stripe onboarding');
  }
  if (!own) throw new Error('Session has no tenant');
  if (requested && requested !== own) {
    throw new Error('Tenant admins can only onboard their own tenant');
  }
  return own;
}

/** Create (or refresh) the hosted Stripe onboarding link for a tenant. The
 * caller redirects the browser to the returned URL; Stripe returns to the
 * originating flow afterwards: the onboarding wizard (which resumes at the
 * business-information step) or /settings/business. */
export async function createStripeOnboardingLinkAction(
  tenantId?: number,
): Promise<ActionResult<{ url: string; stripe_account_id: string }>> {
  return authedAction(async (session) => {
    const tid = resolveTenant(session, tenantId);
    // Public URL of this console (OPERATOR_UI_URL in compose); Stripe sends
    // the browser back here. The onboarding wizard is gone, so the only
    // return point is the business settings page.
    const base = process.env.OPERATOR_UI_URL || 'http://localhost:3000';
    const returnPath = '/settings/business';
    const result = await paymentApi('/onboarding-link', {
      method: 'POST',
      body: JSON.stringify({
        tenant_id: tid,
        return_url: `${base}${returnPath}?stripe=return`,
        refresh_url: `${base}${returnPath}?stripe=refresh`,
      }),
    });
    await audit({
      actor: session.user.email ?? session.user.name ?? 'unknown',
      actorRoles: session.user.roles,
      tenantId: tid,
      action: 'stripe.onboarding-link',
      target: result.stripe_account_id,
    });
    return result;
  });
}

/** Live readiness of the tenant's Stripe account. */
export async function getStripeConnectStatusAction(
  tenantId?: number,
): Promise<ActionResult<ConnectStatus>> {
  return authedAction(async (session) => {
    const tid = resolveTenant(session, tenantId);
    return paymentApi(`/status?tenant_id=${tid}`, { method: 'GET' });
  });
}

export async function getTenantPlatformFeeAction(
  tenantId: number,
): Promise<ActionResult<{ basis_points: number }>> {
  return authedAction(async (session) => {
    if (!isPlatformAdmin(session.user.roles ?? []))
      throw new Error('Only platform admins can manage fees');
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new Error('Invalid tenant');
    return paymentApi(`/platform-fee?tenant_id=${tenantId}`);
  });
}

export async function setTenantPlatformFeeAction(
  tenantId: number,
  basisPoints: number,
): Promise<ActionResult<{ basis_points: number }>> {
  return authedAction(async (session) => {
    if (!isPlatformAdmin(session.user.roles ?? []))
      throw new Error('Only platform admins can manage fees');
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new Error('Invalid tenant');
    if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000)
      throw new Error('Invalid platform fee');
    const result = await paymentApi(`/platform-fee?tenant_id=${tenantId}`, {
      method: 'PUT',
      body: JSON.stringify({ basis_points: basisPoints }),
    });
    await audit({
      actor: session.user.email ?? 'unknown',
      actorRoles: session.user.roles,
      tenantId,
      action: 'tenant.platform-fee',
      detail: { basis_points: basisPoints },
    });
    return result;
  });
}
