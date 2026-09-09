// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useGetIdentity } from '@refinedev/core';
import type { KeycloakUserIdentity } from '@lib/providers/auth-provider/keycloak-auth-provider';
import config from '@lib/utils/config';
import { hasPlatformRole } from '@lib/utils/csms-claims';

/** localStorage key holding the tenant a *platform* user is acting as (set
 * from the Tenants page). Tenant users are bound by their token and never
 * consult this. */
export const ACTING_TENANT_KEY = 'actingTenantId';

/** Retrieves the tenant ID of the logged in user.
 * Tenant users get the tenant bound to their token. Platform staff act as the
 * tenant selected on the /tenants page when one is selected -- even when
 * their own token carries a home tenant (owner accounts do) -- and otherwise
 * fall back to that home tenant, then to the configured default. **/
export const useTenantId = (): number => {
  const { data: identity } = useGetIdentity<KeycloakUserIdentity>();
  const own = Number(identity?.tenantId);
  const acting =
    typeof window !== 'undefined'
      ? Number(window.localStorage.getItem(ACTING_TENANT_KEY))
      : 0;
  if (acting && hasPlatformRole(identity?.roles)) return acting;
  if (own) return own;
  if (acting) return acting;
  return Number(config.tenantId);
};
