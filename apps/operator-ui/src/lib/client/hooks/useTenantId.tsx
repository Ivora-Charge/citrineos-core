// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useGetIdentity } from '@refinedev/core';
import type { KeycloakUserIdentity } from '@lib/providers/auth-provider/keycloak-auth-provider';
import config from '@lib/utils/config';

/** localStorage key holding the tenant a *platform* user is acting as (set
 * from the Tenants page). Tenant users are bound by their token and never
 * consult this. */
export const ACTING_TENANT_KEY = 'actingTenantId';

/** Retrieves the tenant ID of the logged in user.
 * Tenant users get the tenant bound to their token. Platform staff (no
 * tenant claim) act as the tenant selected on the /tenants page, falling back
 * to the configured default. **/
export const useTenantId = (): number => {
  const { data: identity } = useGetIdentity<KeycloakUserIdentity>();
  const own = Number(identity?.tenantId);
  if (own) return own;
  if (typeof window !== 'undefined') {
    const acting = Number(window.localStorage.getItem(ACTING_TENANT_KEY));
    if (acting) return acting;
  }
  return Number(config.tenantId);
};
