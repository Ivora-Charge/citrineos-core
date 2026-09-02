// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

// Runtime auth provider for the Supabase mode. It reads the NextAuth session
// that app/api/auth/[...nextauth]/options.ts builds from the Supabase JWT
// (accessToken, roles, tenantId). The file and the exported type names keep
// their historical Keycloak spelling only for import stability
// (useTenantId.tsx and authenticated-layout/index.tsx import
// KeycloakUserIdentity); Keycloak itself was torn down.

import { type AuthenticationContextProvider, type User } from '@/lib/utils/access.types';
import config from '@/lib/utils/config';
import { getSession, signIn, signOut } from 'next-auth/react';
import { type AuthProvider } from '@refinedev/core';
import { HasuraHeader, HasuraRole } from '@lib/utils/hasura.types';
import { parseJwt, getTokenClaim } from '@lib/utils/jwt';
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

const HASURA_CLAIM = config.hasuraClaim!;

export const createKeycloakAuthProvider = (): AuthProvider & AuthenticationContextProvider => {
  const getPermissions = async (): Promise<KeycloakPermissions> => {
    const session = await getSession();
    if (!session?.user) {
      return { roles: [], tenants: [], resources: {} };
    }

    const roles = (session.user as any).roles || [];
    return {
      roles,
      tenants: [],
      resources: {},
    };
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
    const session = await getSession();
    if (!session) {
      return hasuraHeaders;
    }
    const token = (session as any).accessToken;
    if (!token) {
      return hasuraHeaders;
    }
    const tokenParsed = parseJwt(token);

    // Set Hasura role. The role sent here must be in the token's
    // x-hasura-allowed-roles (Hasura's claims_map maps them from
    // app_metadata.csms.<env>.roles), so pick the strongest role the user
    // actually holds. Tenant users never hold ADMIN, so they can only ever
    // select their tenant-scoped roles.
    const hasuraClaims = getTokenClaim(tokenParsed, HASURA_CLAIM);
    if (!hasuraClaims) {
      const permissions = await getPermissions();
      const roles = permissions.roles ?? [];

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
    }

    // Tenant id as the session carries it (validated server-side in
    // options.ts). Hasura in JWT mode takes the tenant from the token's
    // claims_map, so this header is informational.
    const tenantId = (session.user as any)?.tenantId;
    if (tenantId) {
      hasuraHeaders.set(HasuraHeader.X_HASURA_TENANT_ID, String(tenantId));
    }

    return hasuraHeaders;
  };

  const getToken = async (): Promise<string | undefined> => {
    const session = await getSession();
    return (session as any)?.accessToken;
  };

  return {
    login: async ({ redirectTo, email, password }: any = {}) => {
      // Supabase is a CredentialsProvider -- there is no IdP to redirect the
      // browser to -- so it signs in with the submitted credentials. The
      // provider id here MUST match what options.ts registers: naming a
      // provider that is not registered makes signIn() fail and bounce back
      // to /login, which calls login() again. That is an infinite redirect
      // loop with no form ever rendered.
      const result = await signIn('supabase', {
        username: email,
        password,
        redirect: false,
      });
      if (!result || result.error) {
        return {
          success: false,
          error: { name: 'LoginError', message: 'Invalid email or password' },
        };
      }
      return { success: true, redirectTo: redirectTo || '/overview' };
    },
    logout: async ({ redirectTo }) => {
      // Supabase has no browser-side SSO cookie to clear: removing the
      // NextAuth session cookie IS the logout.
      await signOut({ redirect: false });
      return { success: true, redirectTo: redirectTo || '/login' };
    },
    check: async () => {
      const session = await getSession();
      if (!session) {
        return { authenticated: false, logout: true, redirectTo: '/login' };
      }
      // Check if token refresh failed
      if ((session as any).error === 'RefreshAccessTokenError') {
        return { authenticated: false, logout: true, redirectTo: '/login' };
      }
      return { authenticated: true };
    },
    getIdentity: async () => {
      const session = await getSession();
      if (!session?.user) return null;

      return {
        id: (session.user as any).sub || '1',
        name: session.user.name,
        email: session.user.email,
        avatar: session.user.image,
        roles: (session.user as any).roles || [],
        tenantId: (session.user as any).tenantId,
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
    // Supabase signs in with credentials, so it uses the same form as the
    // generic provider rather than an IdP redirect splash.
    getLoginPage: () => GenericLoginPage,
  };
};
