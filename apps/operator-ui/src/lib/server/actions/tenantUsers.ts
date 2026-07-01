// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use server';

import { authedAction, type ActionResult } from '@lib/utils/action-guard';
import {
  createUserWithRoles,
  listUsersForTenant,
  type KeycloakUser,
} from '@lib/server/keycloak-admin';
import { audit } from '@lib/server/audit';

// Roles a tenant admin may grant within their own tenant. Platform admins may
// grant any of ALL_ROLES (including platform roles, with no tenant binding).
const TENANT_GRANTABLE = ['tenant-admin', 'tenant-viewer'];
const ALL_ROLES = ['platform-admin', 'platform-support', ...TENANT_GRANTABLE];

const isPlatformAdmin = (roles: string[]) =>
  roles.includes('platform-admin') || roles.includes('admin');

export interface InviteUserInput {
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  /** Required for tenant-* roles; ignored for platform roles. */
  tenantId?: string;
}

export interface InviteUserResult {
  username: string;
  /** Shown once to the inviter; Keycloak forces a change on first login. */
  tempPassword: string;
}

/**
 * Create a user in the ivora realm (multi-tenant rollout Phase 3).
 *
 * platform-admin: may invite into any tenant and grant any role.
 * tenant-admin: may invite only into their own tenant and grant only
 * tenant-admin / tenant-viewer.
 *
 * Every user also gets tenant-viewer: it is Hasura's default role, so it must
 * be in every token's allowed-roles (see the claims_map in the compose file).
 */
export async function inviteUserAction(
  input: InviteUserInput,
): Promise<ActionResult<InviteUserResult>> {
  return authedAction<InviteUserResult>(async (session) => {
    const callerRoles = session.user.roles ?? [];
    const platform = isPlatformAdmin(callerRoles);

    if (!ALL_ROLES.includes(input.role)) {
      throw new Error(`Unknown role: ${input.role}`);
    }
    if (!platform) {
      if (!callerRoles.includes('tenant-admin')) {
        throw new Error('Only platform or tenant admins can invite users');
      }
      if (!TENANT_GRANTABLE.includes(input.role)) {
        throw new Error('Tenant admins can only grant tenant roles');
      }
      if (!session.user.tenantId || input.tenantId !== session.user.tenantId) {
        throw new Error('Tenant admins can only invite users into their own tenant');
      }
    }

    const isTenantRole = TENANT_GRANTABLE.includes(input.role);
    if (isTenantRole && !input.tenantId) {
      throw new Error('tenantId is required for tenant roles');
    }

    const { tempPassword } = await createUserWithRoles({
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      tenantId: isTenantRole ? input.tenantId : undefined,
      roles: [...new Set([input.role, 'tenant-viewer'])],
    });
    await audit({
      actor: session.user.email ?? session.user.name ?? 'unknown',
      actorRoles: callerRoles,
      tenantId: isTenantRole ? input.tenantId : undefined,
      action: 'tenant.invite-user',
      target: input.email,
      detail: { role: input.role },
    });
    return { username: input.email, tempPassword };
  });
}

/** List the Keycloak users bound to a tenant. Platform staff may inspect any
 * tenant; tenant admins only their own. */
export async function listTenantUsersAction(
  tenantId: string,
): Promise<ActionResult<KeycloakUser[]>> {
  return authedAction<KeycloakUser[]>(async (session) => {
    const callerRoles = session.user.roles ?? [];
    const platform =
      isPlatformAdmin(callerRoles) || callerRoles.includes('platform-support');
    if (!platform && session.user.tenantId !== tenantId) {
      throw new Error('Not allowed to inspect other tenants');
    }
    return listUsersForTenant(tenantId);
  });
}
