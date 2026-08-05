// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use server';

/**
 * Self-signup (public, unauthenticated): create a tenant + its first
 * tenant-admin in one step, gated behind email verification.
 *
 * Flow: validate -> rate-limit -> create Tenants row (Hasura admin) ->
 * create DISABLED Keycloak user with the chosen password, tenant_id and
 * tenant-admin/tenant-viewer roles -> send a signed verification link via
 * Resend. /signup/verify enables the account; until then login is refused by
 * Keycloak, so an unverified signup can't touch anything.
 *
 * Keycloak's own registrationAllowed stays OFF: this action is the only door,
 * and it never creates a user without a tenant.
 */

import { headers } from 'next/headers';

import config from '@lib/utils/config';
import { audit } from '@lib/server/audit';
import {
  createUserWithRoles,
  deleteUser,
  findUserIdByEmail,
} from '@lib/server/keycloak-admin';
import { emailConfigured, sendEmail } from '@lib/server/resend';
import { issueVerificationToken } from '@lib/server/signup-token';

export interface SelfSignupInput {
  organization: string;
  firstName?: string;
  lastName?: string;
  email: string;
  password: string;
  /** Honeypot -- humans never see this field; bots that fill it are dropped. */
  website?: string;
}

export type SelfSignupResult =
  | { success: true }
  | { success: false; error: string };

// Sliding-window rate limit per client IP. In-memory is fine: the UI runs as
// a single container, and this only has to blunt drive-by abuse.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const attempts = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  attempts.set(ip, recent);
  if (attempts.size > 10_000) attempts.clear(); // unbounded-growth backstop
  return recent.length > MAX_PER_WINDOW;
}

// createdAt/updatedAt are NOT NULL with no DB default (Sequelize-managed
// timestamps), so they must be supplied explicitly -- same as the tenants page.
const TENANT_INSERT = `
  mutation SelfSignupTenant($name: String!, $now: timestamptz!) {
    insert_Tenants_one(
      object: { name: $name, createdAt: $now, updatedAt: $now }
    ) { id }
  }
`;

const TENANT_DELETE = `
  mutation SelfSignupTenantRollback($id: Int!) {
    delete_Tenants_by_pk(id: $id) { id }
  }
`;

async function hasura(query: string, variables: Record<string, unknown>) {
  const res = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.hasuraAdminSecret
        ? { 'x-hasura-admin-secret': config.hasuraAdminSecret }
        : {}),
    },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
}

export async function selfSignupAction(
  input: SelfSignupInput,
): Promise<SelfSignupResult> {
  try {
    if (process.env.SELF_SIGNUP_ENABLED !== 'true') {
      return { success: false, error: 'Self sign-up is not enabled.' };
    }
    if (!emailConfigured()) {
      return {
        success: false,
        error: 'Sign-up is temporarily unavailable (email is not configured).',
      };
    }

    // Honeypot: report success so the bot learns nothing.
    if ((input.website ?? '').trim() !== '') return { success: true };

    const ip =
      (await headers()).get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
    if (rateLimited(ip)) {
      return { success: false, error: 'Too many sign-ups; try again later.' };
    }

    const organization = (input.organization ?? '').trim();
    const email = (input.email ?? '').trim().toLowerCase();
    const password = input.password ?? '';
    if (organization.length < 2 || organization.length > 100) {
      return { success: false, error: 'Enter your organization name.' };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { success: false, error: 'Enter a valid email address.' };
    }
    if (password.length < 10) {
      return {
        success: false,
        error: 'Choose a password of at least 10 characters.',
      };
    }

    if (await findUserIdByEmail(email)) {
      return {
        success: false,
        error: 'An account with this email already exists. Try signing in.',
      };
    }

    const tenantId = (
      await hasura(TENANT_INSERT, {
        name: organization,
        now: new Date().toISOString(),
      })
    ).insert_Tenants_one.id as number;

    let userId: string;
    try {
      ({ userId } = await createUserWithRoles({
        email,
        firstName: input.firstName?.trim() || undefined,
        lastName: input.lastName?.trim() || undefined,
        tenantId: String(tenantId),
        roles: ['tenant-admin', 'tenant-viewer'],
        password,
        enabled: false,
      }));
    } catch (err) {
      // Don't leave an orphan tenant behind the failed user creation.
      await hasura(TENANT_DELETE, { id: tenantId }).catch(() => undefined);
      throw err;
    }

    try {
      const base = (process.env.NEXTAUTH_URL ?? '').replace(/\/$/, '');
      const link = `${base}/signup/verify?token=${encodeURIComponent(
        issueVerificationToken(userId),
      )}`;
      await sendEmail({
        to: email,
        subject: 'Confirm your Ivora Charge account',
        html:
          `<p>Welcome to Ivora Charge!</p>` +
          `<p>Confirm your email to activate the account for ` +
          `<strong>${organization.replace(/</g, '&lt;')}</strong>:</p>` +
          `<p><a href="${link}">Activate my account</a></p>` +
          `<p>The link is valid for 24 hours. If you didn't sign up, ` +
          `ignore this email.</p>`,
      });
    } catch (err) {
      // No verification mail means a dead account -- roll everything back so
      // the address can try again cleanly.
      await deleteUser(userId).catch(() => undefined);
      await hasura(TENANT_DELETE, { id: tenantId }).catch(() => undefined);
      throw err;
    }

    await audit({
      actor: email,
      action: 'tenant.self-signup',
      tenantId,
      target: organization,
      detail: { ip },
    });
    return { success: true };
  } catch (err) {
    console.error('[self-signup] failed:', err);
    return {
      success: false,
      error: 'Sign-up failed. Please try again or contact support.',
    };
  }
}
