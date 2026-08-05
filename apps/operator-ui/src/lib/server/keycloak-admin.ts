// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

// Server-side Keycloak Admin REST client (multi-tenant rollout Phase 3).
// Used by the tenant-user server actions to create/invite users and list a
// tenant's members. Credentials are the master-realm admin (KEYCLOAK_ADMIN_USER
// / KEYCLOAK_ADMIN_PASSWORD env, server-only -- never expose to the client).
//
// NOT a 'use server' file: these helpers must only be imported from server
// actions, which enforce the caller's role before touching the admin API.

import config from '@lib/utils/config';

const REALM = () => config.keycloakRealm || 'ivora';
const BASE = () => {
  const url = config.keycloakServerUrl || config.keycloakUrl;
  if (!url) throw new Error('Keycloak is not configured (KEYCLOAK_SERVER_URL)');
  return url.replace(/\/$/, '');
};

export interface KeycloakUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  attributes?: Record<string, string[]>;
  clientRoles?: string[];
}

async function adminToken(): Promise<string> {
  const user = process.env.KEYCLOAK_ADMIN_USER;
  const password = process.env.KEYCLOAK_ADMIN_PASSWORD;
  if (!user || !password) {
    throw new Error('KEYCLOAK_ADMIN_USER / KEYCLOAK_ADMIN_PASSWORD not configured');
  }
  const res = await fetch(`${BASE()}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: user,
      password,
    }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Keycloak admin login failed: HTTP ${res.status}`);
  return (await res.json()).access_token as string;
}

async function api(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE()}/admin/realms/${REALM()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Keycloak admin API ${method} ${path}: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined;
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

let cachedClientUuid: string | undefined;
async function uiClientUuid(token: string): Promise<string> {
  if (cachedClientUuid) return cachedClientUuid;
  const clientId = config.keycloakClientId || 'citrineos-ui';
  const clients = (await api(token, 'GET', `/clients?clientId=${clientId}`)) as Array<{
    id: string;
  }>;
  if (!clients?.length) throw new Error(`Keycloak client ${clientId} not found`);
  cachedClientUuid = clients[0].id;
  return cachedClientUuid;
}

/** List realm users whose tenant_id attribute equals the given tenant, with
 * their citrineos-ui client roles resolved. */
export async function listUsersForTenant(tenantId: string): Promise<KeycloakUser[]> {
  const token = await adminToken();
  const users = (await api(
    token,
    'GET',
    `/users?q=tenant_id:${encodeURIComponent(tenantId)}&max=200`,
  )) as any[];
  const clientUuid = await uiClientUuid(token);
  return Promise.all(
    (users ?? []).map(async (u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      enabled: u.enabled,
      attributes: u.attributes,
      clientRoles: (
        (await api(token, 'GET', `/users/${u.id}/role-mappings/clients/${clientUuid}`)) as any[]
      )?.map((r) => r.name),
    })),
  );
}

/** Create an enabled user with a temporary password (forced change on first
 * login), the tenant_id attribute, and the given citrineos-ui client roles.
 * Returns the generated temporary password -- show it once, never store it. */
export async function createUserWithRoles(args: {
  email: string;
  firstName?: string;
  lastName?: string;
  tenantId?: string;
  roles: string[];
  /** Caller-chosen permanent password (self-signup). Omitted = generated
   * temporary password the user must change on first login (invite flow). */
  password?: string;
  /** Create the account disabled (self-signup: enabled on email verify). */
  enabled?: boolean;
}): Promise<{ userId: string; tempPassword: string }> {
  const token = await adminToken();
  const tempPassword = args.password ?? `Iv-${crypto.randomUUID().slice(0, 13)}`;

  await api(token, 'POST', '/users', {
    username: args.email,
    email: args.email,
    firstName: args.firstName,
    lastName: args.lastName,
    enabled: args.enabled ?? true,
    emailVerified: false,
    attributes: args.tenantId ? { tenant_id: [args.tenantId] } : undefined,
    credentials: [
      {
        type: 'password',
        value: tempPassword,
        temporary: args.password === undefined,
      },
    ],
  });

  const created = (await api(
    token,
    'GET',
    `/users?username=${encodeURIComponent(args.email)}&exact=true`,
  )) as any[];
  if (!created?.length) throw new Error('User created but not found by username');
  const userId = created[0].id as string;

  const clientUuid = await uiClientUuid(token);
  const available = (await api(
    token,
    'GET',
    `/users/${userId}/role-mappings/clients/${clientUuid}/available`,
  )) as Array<{ id: string; name: string }>;
  const toAssign = available.filter((r) => args.roles.includes(r.name));
  if (toAssign.length !== new Set(args.roles).size) {
    const missing = args.roles.filter((r) => !toAssign.some((a) => a.name === r));
    throw new Error(`Unknown client role(s): ${missing.join(', ')}`);
  }
  await api(token, 'POST', `/users/${userId}/role-mappings/clients/${clientUuid}`, toAssign);

  return { userId, tempPassword };
}

/** Look up a user id by exact username/email; undefined when absent. */
export async function findUserIdByEmail(email: string): Promise<string | undefined> {
  const token = await adminToken();
  const users = (await api(
    token,
    'GET',
    `/users?username=${encodeURIComponent(email)}&exact=true`,
  )) as any[];
  return users?.[0]?.id as string | undefined;
}

/** Flip a user to enabled + email-verified (self-signup verification).
 * Read-modify-write: Keycloak's PUT replaces the whole representation, and a
 * partial body would silently drop attributes like tenant_id. */
export async function activateUser(userId: string): Promise<void> {
  const token = await adminToken();
  const user = (await api(token, 'GET', `/users/${userId}`)) as Record<string, unknown>;
  await api(token, 'PUT', `/users/${userId}`, {
    ...user,
    enabled: true,
    emailVerified: true,
  });
}

/** Best-effort removal (self-signup rollback when a later step fails). */
export async function deleteUser(userId: string): Promise<void> {
  const token = await adminToken();
  await api(token, 'DELETE', `/users/${userId}`);
}
