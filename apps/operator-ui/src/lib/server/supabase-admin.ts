// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

// Server-side Supabase Auth (GoTrue) admin client, used by the tenant-user
// server actions to invite users and read/write their CSMS claims. Plain
// fetch against the GoTrue admin endpoints with the service-role key
// (SUPABASE_SERVICE_ROLE_KEY, server-only -- never expose to the client; never
// import supabase-js here, the browser bundle must not pick it up).
//
// NOT a 'use server' file: these helpers must only be imported from server
// actions, which enforce the caller's role before touching the admin API.
//
// Claims shape and write discipline: docs/identity-consolidation-plan.md 2.1.
// app_metadata.csms = { "<env>": { "roles": [...], "tenant_id": "3" } }.
// GoTrue merges only the top-level keys of app_metadata and replaces nested
// objects wholesale, so every claims write is a read-modify-write of the
// whole `csms` object, and nothing else in app_metadata (analytics' `plan`,
// `role`) is ever sent.

import { PLATFORM_ROLES, VALID_ROLES } from '@lib/utils/csms-claims';

const ANALYTICS_URL = (process.env.ANALYTICS_URL || 'https://analytics.ivoracharge.com').replace(
  /\/$/,
  '',
);

// GoTrue defaults to 50 per page; we ask for the maximum it will honour and
// keep paging until a short page, so a project with more than 1000 accounts
// still lists completely.
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

export interface CsmsEnvClaims {
  roles: string[];
  /** JSON string (Hasura session variables are strings). */
  tenant_id?: string;
}

export interface SupabaseUser {
  id: string;
  email?: string;
  app_metadata?: Record<string, unknown> & { csms?: Record<string, CsmsEnvClaims> };
  user_metadata?: Record<string, unknown>;
  created_at?: string;
  invited_at?: string | null;
  confirmed_at?: string | null;
  email_confirmed_at?: string | null;
  last_sign_in_at?: string | null;
  banned_until?: string | null;
}

function authBase(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not configured');
  return `${url.replace(/\/$/, '')}/auth/v1`;
}

function serviceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  return key;
}

async function gotrue<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const key = serviceRoleKey();
  const res = await fetch(`${authBase()}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // GoTrue error bodies are {"code":..,"msg":..} or {"error":..,"error_description":..}.
    let msg = detail.slice(0, 200);
    try {
      const parsed = JSON.parse(detail);
      msg = parsed.msg || parsed.error_description || parsed.error || msg;
    } catch {
      /* keep raw */
    }
    throw new Error(
      `Supabase admin API ${method} ${path.split('?')[0]}: HTTP ${res.status} ${msg}`,
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Every user in the project (all products share it). */
export async function listUsers(): Promise<SupabaseUser[]> {
  const all: SupabaseUser[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await gotrue<{ users?: SupabaseUser[] }>(
      'GET',
      `/admin/users?page=${page}&per_page=${PAGE_SIZE}`,
    );
    const users = data?.users ?? [];
    all.push(...users);
    if (users.length < PAGE_SIZE) break;
  }
  return all;
}

/** GoTrue has no email filter on the admin list, so list and filter. */
export async function findUserByEmail(email: string): Promise<SupabaseUser | undefined> {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return undefined;
  const users = await listUsers();
  return users.find((u) => (u.email ?? '').toLowerCase() === wanted);
}

export async function getUser(userId: string): Promise<SupabaseUser> {
  return gotrue<SupabaseUser>('GET', `/admin/users/${encodeURIComponent(userId)}`);
}

/**
 * Send a Supabase invite email. `redirectTo` must be the analytics Site URL
 * (or another entry of the project's redirect allow-list): the invite link
 * lands on analytics' existing set-password screen, after which the user
 * signs in here with that password. Never add a CSMS host to the allow-list.
 *
 * Note the invite `data` option would go to user_metadata, not app_metadata,
 * so CSMS claims are always written with a second call (writeCsmsClaims).
 */
export async function inviteUser(
  email: string,
  redirectTo: string = ANALYTICS_URL,
): Promise<SupabaseUser> {
  return gotrue<SupabaseUser>('POST', `/invite?redirect_to=${encodeURIComponent(redirectTo)}`, {
    email: email.trim(),
  });
}

function assertValidClaims(claims: CsmsEnvClaims): void {
  if (!Array.isArray(claims.roles) || claims.roles.length === 0) {
    throw new Error('roles must be a non-empty array');
  }
  const bad = claims.roles.filter((r) => !VALID_ROLES.includes(r));
  if (bad.length) throw new Error(`Unknown role(s): ${bad.join(', ')}`);
  const platform = claims.roles.some((r) => (PLATFORM_ROLES as readonly string[]).includes(r));
  if (!platform && !(typeof claims.tenant_id === 'string' && claims.tenant_id.trim() !== '')) {
    throw new Error('tenant_id is required for users without a platform role');
  }
  // Hasura's default role literal must be in every user's allowed roles.
  if (!claims.roles.includes('tenant-viewer')) {
    throw new Error('roles must include tenant-viewer (Hasura default role)');
  }
}

/**
 * Set (or, with null, remove) this environment's CSMS claims for a user.
 * Read-modify-write on the whole `csms` object -- see the header comment for
 * why a partial body is not an option. Returns the updated user.
 */
export async function writeCsmsClaims(
  userId: string,
  env: string,
  claims: CsmsEnvClaims | null,
): Promise<SupabaseUser> {
  if (!env) throw new Error('env is required');
  if (claims) assertValidClaims(claims);

  const current = await getUser(userId);
  const existing = current.app_metadata?.csms;
  const csms: Record<string, CsmsEnvClaims> =
    existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};

  if (claims) {
    const next: CsmsEnvClaims = { roles: [...new Set(claims.roles)] };
    if (typeof claims.tenant_id === 'string' && claims.tenant_id.trim() !== '') {
      next.tenant_id = claims.tenant_id.trim();
    }
    csms[env] = next;
  } else {
    delete csms[env];
  }

  return gotrue<SupabaseUser>('PUT', `/admin/users/${encodeURIComponent(userId)}`, {
    app_metadata: { csms },
  });
}

/** This environment's claims for a user, if any. */
export function csmsClaimsOf(user: SupabaseUser, env: string): CsmsEnvClaims | undefined {
  const scoped = user.app_metadata?.csms?.[env];
  if (!scoped || typeof scoped !== 'object' || !Array.isArray(scoped.roles)) return undefined;
  return scoped;
}

/** Users whose claims for `env` bind them to `tenantId` (their home tenant).
 * Client-side filter over the full list until Phase 4's memberships table. */
export async function listUsersForTenant(env: string, tenantId: string): Promise<SupabaseUser[]> {
  const wanted = tenantId.trim();
  const users = await listUsers();
  return users.filter((u) => csmsClaimsOf(u, env)?.tenant_id === wanted);
}
