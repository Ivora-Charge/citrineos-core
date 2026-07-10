// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import { type AuthenticationContextProvider, type User } from '@/lib/utils/access.types';
import config from '@/lib/utils/config';
import { getSession, signIn, signOut } from 'next-auth/react';
import { type AuthProvider, useTranslate } from '@refinedev/core';
import { HasuraHeader, HasuraRole } from '@lib/utils/hasura.types';
import React, { useEffect } from 'react';
import { parseJwt, getTokenClaim } from '@lib/utils/jwt';

export enum KeycloakRole {
  // Legacy roles (pre multi-tenant rollout). ADMIN doubles as Hasura's
  // built-in all-access role, so it is assigned to platform staff only.
  ADMIN = 'admin',
  USER = 'user',
  // Multi-tenant rollout roles (client roles on citrineos-ui; see
  // keycloak/README.md). Tenant users carry ONLY tenant-* roles so they can
  // never claim the Hasura admin role.
  PLATFORM_ADMIN = 'platform-admin',
  PLATFORM_SUPPORT = 'platform-support',
  TENANT_ADMIN = 'tenant-admin',
  TENANT_VIEWER = 'tenant-viewer',
}

/**
 * Extended user identity with Keycloak-specific fields
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

/**
 * Keycloak Login Page Component
 * Automatically redirects to Keycloak login
 */
const KeycloakLoginPage: React.FC = () => {
  const translate = useTranslate();
  useEffect(() => {
    signIn('keycloak', { callbackUrl: '/overview' });
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="text-center">
        <h2 className="text-xl font-semibold mb-2">{translate('pages.redirectingToKeycloak')}</h2>
        <p className="text-gray-600">{translate('pages.redirectingToKeycloakLogin')}</p>
      </div>
    </div>
  );
};

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
    // x-hasura-allowed-roles (Hasura claims_map maps them from the
    // citrineos-ui client roles), so pick the strongest role the user
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

    // Set Hasura tenant ID
    const tenantId = tokenParsed.tenantId;
    if (tenantId) {
      hasuraHeaders.set(HasuraHeader.X_HASURA_TENANT_ID, tenantId);
    }

    return hasuraHeaders;
  };

  const getToken = async (): Promise<string | undefined> => {
    const session = await getSession();
    return (session as any)?.accessToken;
  };

  return {
    login: async ({ redirectTo }) => {
      await signIn('keycloak', { callbackUrl: redirectTo || '/overview' });
      return { success: true };
    },
    logout: async ({ redirectTo }) => {
      const session = await getSession();
      const idToken = (session as any)?.idToken;
      const keycloakLogoutUrl = (session as any)?.keycloakLogoutUrl;

      // Clear the NextAuth session cookie without triggering a redirect
      await signOut({ redirect: false });

      // Redirect the browser to Keycloak's end-session endpoint so it can
      // clear its own SSO cookie. Without this, Keycloak silently re-authenticates
      // the user on the next check because the browser-side SSO session is still live.
      if (idToken && keycloakLogoutUrl) {
        const postLogoutUri = `${window.location.origin}${redirectTo || '/login'}`;
        const params = new URLSearchParams({
          id_token_hint: idToken,
          post_logout_redirect_uri: postLogoutUri,
        });
        window.location.href = `${keycloakLogoutUrl}?${params.toString()}`;
        return { success: true };
      }

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
    getLoginPage: () => KeycloakLoginPage,
  };
};
