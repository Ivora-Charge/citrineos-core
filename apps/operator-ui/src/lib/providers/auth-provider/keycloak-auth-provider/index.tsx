// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

// Runtime auth provider for the Supabase mode. The session is the Supabase
// session in the shared SSO cookie (@lib/utils/auth-cookie): a user who
// signed in on the analytics product is already signed in here, and the
// password form below is the fallback for staff who come here directly.
// Roles and tenant are read from the token's app_metadata.csms[CSMS_ENV]
// (@lib/utils/csms-claims); the server (middleware, actions, core proxy)
// re-validates them on every request, so what is read here only drives the
// UI. The file and the exported type names keep their historical Keycloak
// spelling only for import stability (useTenantId.tsx and
// authenticated-layout/index.tsx import KeycloakUserIdentity).

import { type AuthenticationContextProvider, type User } from '@/lib/utils/access.types';
import config from '@/lib/utils/config';
import { type AuthProvider } from '@refinedev/core';
import { HasuraHeader, HasuraRole } from '@lib/utils/hasura.types';
import { parseJwt } from '@lib/utils/jwt';
import { readCsmsClaims, hasFleetAccess, type CsmsClaims } from '@lib/utils/csms-claims';
import { readBillingBlock } from '@lib/utils/billing-claims';
import { createPlatformRoleRefreshGuard } from '@lib/utils/platform-role-refresh';
import { getBrowserSupabase, recordExplicitTestSignIn, recordTestSignOut } from '@lib/supabase/browser';
import { GenericLoginPage } from '@lib/providers/auth-provider/generic-auth-provider';

export enum KeycloakRole {
  // Legacy roles (pre multi-tenant rollout). ADMIN doubles as Hasura's
  // built-in all-access role, so it is assigned to platform staff only.
  ADMIN = 'admin',
  USER = 'user',
  // Multi-tenant roles, carried in the Supabase JWT at
  // app_metadata.csms[CSMS_ENV].roles (see @lib/utils/csms-claims). Tenant
  // users carry ONLY tenant-* roles so they can never claim the Hasura admin
  // role.
  PLATFORM_ADMIN = 'platform-admin',
  PLATFORM_SUPPORT = 'platform-support',
  TENANT_ADMIN = 'tenant-admin',
  TENANT_VIEWER = 'tenant-viewer',
}

/**
 * Extended user identity with the CSMS-specific fields the session carries.
 */
export interface KeycloakUserIdentity extends User {
  tenantId?: string;
  avatar?: string;
}

export interface KeycloakPermissions {
  roles: string[];
  tenants?: string[];
  resources?: Record<string, string[]>;
}

interface Current {
  accessToken: string;
  claims: Record<string, unknown>;
  csms: CsmsClaims | null;
  blocked: boolean;
}

const platformRoleRefresh = createPlatformRoleRefreshGuard();

/** The current session, or null when signed out. `csms` is null when the
 * account has no access to this environment (the server refuses it too). */
const current = async (): Promise<Current | null> => {
  const supabase = getBrowserSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  let accessToken = session?.access_token;
  if (!accessToken) return null;
  let claims = parseJwt(accessToken) ?? {};
  if (await platformRoleRefresh.refreshIfNeeded(
    readCsmsClaims(claims, config.csmsEnv)?.roles,
    () => supabase.auth.refreshSession(),
  )) {
    const { data: refreshed } = await supabase.auth.getSession();
    accessToken = refreshed.session?.access_token;
    if (!accessToken) return null;
    claims = parseJwt(accessToken) ?? {};
  }
  return {
    accessToken,
    claims,
    csms: readCsmsClaims(claims, config.csmsEnv),
    blocked: readBillingBlock(claims) !== null,
  };
};

const usable = (c: Current | null): c is Current & { csms: CsmsClaims } =>
  !!c && !!c.csms && hasFleetAccess(c.csms) && !c.blocked;

export const createKeycloakAuthProvider = (): AuthProvider & AuthenticationContextProvider => {
  const getPermissions = async (): Promise<KeycloakPermissions> => {
    const c = await current();
    if (!usable(c)) {
      return { roles: [], tenants: [], resources: {} };
    }
    return { roles: c.csms.roles, tenants: [], resources: {} };
  };

  const getUserRole = async (): Promise<string | undefined> => {
    const permissions = await getPermissions();
    const roles = permissions.roles;

    if (roles && roles.length > 0) {
      // Map onto the two UI permission tiers the access provider knows today
      // (Phase 3 refines this into per-role capability maps): admin-level
      // roles get full UI access, viewer/support get the standard tier.
      if (
        roles.includes(KeycloakRole.ADMIN) ||
        roles.includes(KeycloakRole.PLATFORM_ADMIN) ||
        roles.includes(KeycloakRole.TENANT_ADMIN)
      ) {
        return KeycloakRole.ADMIN;
      }
      if (
        roles.includes(KeycloakRole.USER) ||
        roles.includes(KeycloakRole.PLATFORM_SUPPORT) ||
        roles.includes(KeycloakRole.TENANT_VIEWER)
      ) {
        return KeycloakRole.USER;
      }
    }
    return undefined;
  };

  const getHasuraHeaders = async (): Promise<Map<HasuraHeader, string>> => {
    const hasuraHeaders = new Map<HasuraHeader, string>();
    const c = await current();
    if (!usable(c)) {
      return hasuraHeaders;
    }
    const roles = c.csms.roles;

    // Set Hasura role. The role sent here must be in the token's
    // x-hasura-allowed-roles (Hasura's claims_map maps them from
    // app_metadata.csms.<env>.roles), so pick the strongest role the user
    // actually holds. Tenant users never hold ADMIN, so they can only ever
    // select their tenant-scoped roles.
    if (roles.includes(KeycloakRole.ADMIN) || roles.includes(KeycloakRole.PLATFORM_ADMIN)) {
      hasuraHeaders.set(HasuraHeader.X_HASURA_ROLE, HasuraRole.ADMIN);
    } else if (roles.includes(KeycloakRole.TENANT_ADMIN)) {
      hasuraHeaders.set(HasuraHeader.X_HASURA_ROLE, KeycloakRole.TENANT_ADMIN);
    } else if (roles.includes(KeycloakRole.PLATFORM_SUPPORT)) {
      hasuraHeaders.set(HasuraHeader.X_HASURA_ROLE, KeycloakRole.PLATFORM_SUPPORT);
    } else if (roles.includes(KeycloakRole.TENANT_VIEWER)) {
      hasuraHeaders.set(HasuraHeader.X_HASURA_ROLE, KeycloakRole.TENANT_VIEWER);
    } else {
      hasuraHeaders.set(HasuraHeader.X_HASURA_ROLE, HasuraRole.USER);
    }

    // Hasura in JWT mode takes the tenant from the token's claims_map, so
    // this header is informational.
    if (c.csms.tenantId) {
      hasuraHeaders.set(HasuraHeader.X_HASURA_TENANT_ID, c.csms.tenantId);
    }

    return hasuraHeaders;
  };

  const getToken = async (): Promise<string | undefined> => {
    const c = await current();
    return usable(c) ? c.accessToken : undefined;
  };

  return {
    login: async ({ redirectTo, email, password }: any = {}) => {
      // Password fallback. A successful sign-in writes the shared cookie, so
      // the user is signed in on the analytics product as well.
      const { data, error } = await getBrowserSupabase().auth.signInWithPassword({
        email,
        password,
      });
      if (error || !data.session) {
        return {
          success: false,
          error: { name: 'LoginError', message: 'Invalid email or password' },
        };
      }
      platformRoleRefresh.resetAfterExplicitSignIn();
      recordExplicitTestSignIn();
      const claims = parseJwt(data.session.access_token) ?? {};
      if (!hasFleetAccess(readCsmsClaims(claims, config.csmsEnv))) {
        // Signed in to the Ivora account, but it has no grant for this
        // console. The session is left in place (it is valid for analytics);
        // middleware keeps this app closed to it.
        return {
          success: false,
          error: { name: 'NoAccess', message: 'This account has no access to this console' },
        };
      }
      if (readBillingBlock(claims)) {
        return {
          success: false,
          error: { name: 'Suspended', message: 'This account is suspended' },
        };
      }
      return { success: true, redirectTo: redirectTo || '/overview' };
    },
    logout: async ({ redirectTo }) => {
      // Clears the shared cookie: this signs the user out of the analytics
      // product in this browser too (that is what single sign-on means).
      // scope 'local' keeps the user's sessions on other devices.
      recordTestSignOut();
      await getBrowserSupabase().auth.signOut({ scope: 'local' });
      return { success: true, redirectTo: redirectTo || '/login' };
    },
    check: async () => {
      const c = await current();
      if (!c) {
        return { authenticated: false, logout: true, redirectTo: '/login' };
      }
      if (!c.csms || !hasFleetAccess(c.csms)) {
        return { authenticated: false, logout: true, redirectTo: '/login?error=NoAccess' };
      }
      if (c.blocked) {
        return { authenticated: false, logout: true, redirectTo: '/login?error=Suspended' };
      }
      return { authenticated: true };
    },
    getIdentity: async () => {
      const c = await current();
      if (!usable(c)) return null;
      const email = typeof c.claims.email === 'string' ? c.claims.email : undefined;
      return {
        id: String(c.claims.sub ?? '1'),
        name: email,
        email,
        roles: c.csms.roles,
        tenantId: c.csms.tenantId,
      } as User;
    },
    getPermissions,
    onError: async (error) => {
      console.error('Auth error:', error);

      // Only logout for auth errors
      if (error.statusCode === 401) {
        return { logout: true };
      }
      return { error };
    },

    // AuthenticationContextProvider methods
    getToken,
    getUserRole,
    getHasuraHeaders,
    getInitialized: async (): Promise<boolean> => true,
    getLoginPage: () => GenericLoginPage,
  };
};
