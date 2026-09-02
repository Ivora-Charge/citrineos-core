// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

/**
 * NextAuth configuration.
 *
 * Providers:
 * - 'supabase' (every public box): a CredentialsProvider that exchanges the
 *   email/password for a GoTrue session (password grant) and keeps the
 *   Supabase access/refresh tokens inside the encrypted NextAuth JWT cookie.
 *   Authorization claims are read from the Supabase JWT's
 *   app_metadata.csms[CSMS_ENV] (see @lib/utils/csms-claims). A user whose
 *   claims fail validation is refused at sign-in and, because the same check
 *   runs on every refresh, signed out within one access-token lifetime
 *   (one hour) after being de-provisioned.
 * - 'generic' (local development only): static admin login from env;
 *   config.ts refuses to start with it when NODE_ENV=production.
 *
 * Token refresh: the Supabase access token is refreshed 60 seconds before it
 * expires using the rotating refresh token. A failed refresh marks the token
 * with error=RefreshAccessTokenError; middleware.ts and the client auth
 * provider both treat that as "logged out".
 */

import type { AuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import config from '@lib/utils/config';
import { parseJwt } from '@lib/utils/jwt';
import { readCsmsClaims } from '@lib/utils/csms-claims';
import { genericAdminUser } from '@lib/providers/auth-provider/generic-auth-provider';

const authProvider = config.authProvider;

/**
 * Refreshes an expired access token using the refresh token
 */
async function refreshAccessToken(token: any) {
  if (authProvider !== 'supabase') {
    // The generic dev provider has no upstream token to refresh.
    return token;
  }

  try {
    const res = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey! },
      body: JSON.stringify({ refresh_token: token.refreshToken }),
    });
    if (!res.ok) throw new Error(`supabase refresh failed: ${res.status}`);
    const data = await res.json();
    const claims = parseJwt(data.access_token);
    // Re-validate on every refresh so a user whose claims were revoked or
    // corrupted since sign-in is logged out at the next refresh, not kept
    // alive by the cookie.
    const csms = readCsmsClaims(claims, config.csmsEnv);
    if (!csms) {
      console.warn('[auth] refreshed Supabase token carries no valid CSMS claims; ending session');
      return { ...token, error: 'RefreshAccessTokenError' };
    }
    return {
      ...token,
      accessToken: data.access_token,
      // GoTrue rotates the refresh token; replaying the old one fails.
      refreshToken: data.refresh_token ?? token.refreshToken,
      accessTokenExpires: Date.now() + (data.expires_in ?? 3600) * 1000,
      roles: csms.roles,
      tenantId: csms.tenantId,
      error: undefined,
    };
  } catch (error) {
    console.error('Error refreshing access token:', error);
    return { ...token, error: 'RefreshAccessTokenError' };
  }
}

/**
 * Supabase in every deployed environment; the generic dev login otherwise
 * (config.ts guarantees 'generic' never resolves in production).
 */
const getProvider = () => {
  if (authProvider === 'supabase') {
    // Supabase Auth serves OIDC discovery and an OAuth 2.1 authorization
    // server (public beta). operator-ui is not yet registered as a client, so
    // it uses the password grant here and NextAuth keeps owning the session
    // cookie; see docs/identity-consolidation-plan.md 2.5 for the redirect
    // login spike. Everything downstream (data-provider, live-provider,
    // Hasura) is token-agnostic and needs no change.
    return CredentialsProvider({
      id: 'supabase',
      name: 'Ivora',
      credentials: {
        username: { label: 'Email', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials?.password) return null;
        const res = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey! },
          body: JSON.stringify({
            email: credentials.username,
            password: credentials.password,
          }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data?.access_token) return null;

        const claims = parseJwt(data.access_token);
        // The Supabase project is shared with the analytics product, whose
        // own app_metadata.role / .plan must never grant authority here. Only
        // the namespaced csms[CSMS_ENV] subtree counts, and a Supabase account
        // without a valid one (anyone can self-register through analytics)
        // gets no session at all.
        const csms = readCsmsClaims(claims, config.csmsEnv);
        if (!csms) return null;
        return {
          id: claims.sub,
          email: claims.email,
          name: claims.email,
          roles: csms.roles,
          tenantId: csms.tenantId,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          accessTokenExpires: Date.now() + (data.expires_in ?? 3600) * 1000,
        } as any;
      },
    });
  }
  return CredentialsProvider({
    id: 'generic',
    credentials: {
      username: { label: 'Username', type: 'text' },
      password: { label: 'Password', type: 'password' },
    },
    async authorize(credentials, _req) {
      if (
        credentials &&
        credentials.username === config.adminEmail &&
        credentials.password === config.adminPassword
      ) {
        return genericAdminUser;
      } else {
        return null;
      }
    },
  });
};

const authOptions: AuthOptions = {
  providers: [getProvider()],
  events: {},
  callbacks: {
    async redirect({ url, baseUrl }) {
      // Redirect to overview page after successful login
      // If the url is a NextAuth callback or the signin page, redirect to overview
      if (url.startsWith(baseUrl)) {
        // Check if it's a callback or sign-in, redirect to overview
        if (url.includes('/api/auth/callback') || url.includes('/api/auth/signin')) {
          return `${baseUrl}/overview`;
        }
        return url;
      }
      // Allow relative callback URLs
      if (url.startsWith('/')) {
        return `${baseUrl}${url}`;
      }
      // Default to overview page for any other case
      return `${baseUrl}/overview`;
    },
    async jwt({ token, user }) {
      // Both providers are CredentialsProviders, so on the initial sign-in
      // NextAuth hands us whatever authorize() returned on `user`.
      if (user) {
        const u = user as any;
        token.roles = u.roles ?? [];
        token.tenantId = u.tenantId;
        if (authProvider === 'supabase') {
          token.accessToken = u.accessToken;
          token.refreshToken = u.refreshToken;
          token.accessTokenExpires = u.accessTokenExpires;
        }
        return token;
      }

      if (authProvider !== 'supabase') {
        return token;
      }

      // Return previous token if the access token has not expired yet
      // Add a 60 second buffer to refresh before actual expiration
      if (Date.now() < (token.accessTokenExpires as number) - 60000) {
        return token;
      }

      // Access token has expired, try to refresh it
      return refreshAccessToken(token);
    },
    async session({ session, token }) {
      // Pass JWT info to client session
      if (session.user) {
        (session.user as any).roles = token.roles;
        (session.user as any).tenantId = token.tenantId;
      }
      (session as any).accessToken = token.accessToken;
      (session as any).error = token.error;
      return session;
    },
  },
  session: {
    strategy: 'jwt',
  },
  pages: {
    signIn: '/login',
  },
};

export default authOptions;
