// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use server';

import { authedAction, ForbiddenError, type ActionResult } from '@lib/utils/action-guard';
import { hasPlatformRole, normalizeCsmsGrantRoles } from '@lib/utils/csms-claims';
import config from '@lib/utils/config';
import {
  csmsClaimsOf,
  findUserByEmail,
  inviteUser,
  listUsersForTenant,
  writeCsmsClaims,
  type SupabaseUser,
} from '@lib/server/supabase-admin';
import { audit } from '@lib/server/audit';

// Roles a tenant admin may grant within their own tenant. Platform admins may
// grant any of ALL_ROLES (including platform roles).
const TENANT_GRANTABLE = ['tenant-admin', 'tenant-viewer'];
const ALL_ROLES = ['platform-admin', 'platform-support', ...TENANT_GRANTABLE];

const isPlatformAdmin = (roles: string[]) =>
  roles.includes('platform-admin') || roles.includes('admin');

/** Which subtree of app_metadata.csms this box writes and reads. */
function csmsEnv(): string {
  const env = config.csmsEnv;
  if (!env) throw new Error('CSMS_ENV is not configured');
  return env;
}

export interface InviteUserInput {
  email: string;
  role: string;
  /** Required for tenant-* roles; for platform roles it becomes the user's
   * home tenant when given. */
  tenantId?: string;
}

export interface InviteUserResult {
  /** The login: the email address. */
  username: string;
  /** true when a Supabase invite email went out (new account); false when the
   * address already had a Supabase account and only the claims were written. */
  emailSent: boolean;
}

/** A tenant member as shown on the tenant page. */
export interface TenantUser {
  id: string;
  email: string;
  roles: string[];
  tenantId?: string;
  /** Has accepted the invite / confirmed the email (can sign in). */
  confirmed: boolean;
  invitedAt?: string | null;
  lastSignInAt?: string | null;
}

function toTenantUser(user: SupabaseUser, env: string): TenantUser {
  const claims = csmsClaimsOf(user, env);
  return {
    id: user.id,
    email: user.email ?? '',
    roles: claims?.roles ?? [],
    tenantId: claims?.tenant_id,
    confirmed: Boolean(user.email_confirmed_at || user.confirmed_at),
    invitedAt: user.invited_at ?? null,
    lastSignInAt: user.last_sign_in_at ?? null,
  };
}

/**
 * Invite a user into a tenant (docs/identity-consolidation-plan.md 2.4).
 *
 * platform-admin: may invite into any tenant and grant any role.
 * tenant-admin: may invite only into their own tenant and grant only
 * tenant-admin / tenant-viewer.
 *
 * If the email already has a Supabase account (analytics customers, staff),
 * no invite is sent and only this environment's claims are written. Otherwise
 * GoTrue sends its invite email whose link lands on analytics' set-password
 * screen; the claims are written right after (the invite cannot set
 * app_metadata itself).
 *
 * Support-only grants never gain a tenant role or a home tenant.
 */
export async function inviteUserAction(
  input: InviteUserInput,
): Promise<ActionResult<InviteUserResult>> {
  return authedAction<InviteUserResult>(async (session) => {
    const env = csmsEnv();
    const callerRoles = session.user.roles ?? [];
    const platform = isPlatformAdmin(callerRoles);

    if (!ALL_ROLES.includes(input.role)) {
      throw new Error(`Unknown role: ${input.role}`);
    }
    // The username IS the email. Validate here so a non-email value gets a
    // clear message instead of the raw GoTrue 4xx bubbling into the UI toast.
    const email = (input.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Enter a valid email address — it becomes the user’s login.');
    }
    const targetTenantId = input.tenantId?.trim() || undefined;

    if (!platform) {
      if (!callerRoles.includes('tenant-admin')) {
        throw new ForbiddenError('Only platform or tenant admins can invite users');
      }
      if (!TENANT_GRANTABLE.includes(input.role)) {
        throw new ForbiddenError('Tenant admins can only grant tenant roles');
      }
      if (!session.user.tenantId || targetTenantId !== session.user.tenantId) {
        throw new ForbiddenError('Tenant admins can only invite users into their own tenant');
      }
    }

    const isTenantRole = TENANT_GRANTABLE.includes(input.role);
    if (isTenantRole && !targetTenantId) {
      throw new Error('tenantId is required for tenant roles');
    }

    const roles = normalizeCsmsGrantRoles([input.role]);
    const claims = { roles, tenant_id: targetTenantId };

    const existing = await findUserByEmail(email);
    let userId: string;
    let emailSent: boolean;
    if (existing) {
      // A tenant admin may not re-point (or downgrade) an account that already
      // belongs to another tenant or to platform staff in this environment.
      const current = csmsClaimsOf(existing, env);
      if (
        !platform &&
        current &&
        (hasPlatformRole(current.roles) || current.tenant_id !== targetTenantId)
      ) {
        throw new ForbiddenError(
          'This email already has access under a different organisation — contact Ivora support.',
        );
      }
      userId = existing.id;
      emailSent = false;
    } else {
      const invited = await inviteUser(email);
      userId = invited.id;
      emailSent = true;
    }
    await writeCsmsClaims(userId, env, claims);

    await audit({
      actor: session.user.email ?? session.user.name ?? 'unknown',
      actorRoles: callerRoles,
      tenantId: isTenantRole ? targetTenantId : undefined,
      action: 'tenant.invite-user',
      target: email,
      detail: { role: input.role, env, emailSent, existingAccount: Boolean(existing) },
    });
    return { username: email, emailSent };
  });
}

/** Membership details require management access. Tenant admins are limited
 * to their own tenant; regular viewers and support cannot list members. */
export async function listTenantUsersAction(tenantId: string): Promise<ActionResult<TenantUser[]>> {
  return authedAction<TenantUser[]>(async (session) => {
    const env = csmsEnv();
    const callerRoles = session.user.roles ?? [];
    if (
      (!isPlatformAdmin(callerRoles) && !callerRoles.includes('tenant-admin')) ||
      (!isPlatformAdmin(callerRoles) && session.user.tenantId !== tenantId)
    ) {
      throw new ForbiddenError('Not allowed to inspect other tenants');
    }
    const users = await listUsersForTenant(env, tenantId);
    return users.map((u) => toTenantUser(u, env)).sort((a, b) => a.email.localeCompare(b.email));
  });
}
