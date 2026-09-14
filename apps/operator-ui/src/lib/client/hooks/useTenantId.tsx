// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useGetIdentity } from '@refinedev/core';
import type { KeycloakUserIdentity } from '@lib/providers/auth-provider/keycloak-auth-provider';
import config from '@lib/utils/config';
import { hasPlatformAdminRole, hasTenantAccess } from '@lib/utils/csms-claims';

/** localStorage key holding the tenant a *platform* user is acting as (set
 * from the Tenants page). Tenant users are bound by their token and never
 * consult this. */
export const ACTING_TENANT_KEY = 'actingTenantId';

/** Tenant users use their token's tenant; platform admins may select one.
 * Support-only users have no tenant context. A previous browser selection
 * never grants tenant access, and the configured default is for local dev only. */
export const useTenantId = (): number => {
  const { data: identity } = useGetIdentity<KeycloakUserIdentity>();
  const own = Number(identity?.tenantId);
  const acting =
    typeof window !== 'undefined' ? Number(window.localStorage.getItem(ACTING_TENANT_KEY)) : 0;
  if (!hasTenantAccess(identity?.roles)) return 0;
  if (acting && hasPlatformAdminRole(identity?.roles)) return acting;
  if (own) return own;
  return config.authProvider === 'generic' ? Number(config.tenantId) : 0;
};
