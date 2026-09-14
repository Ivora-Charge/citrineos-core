// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

/**
 * CSMS authorization claims carried in the Supabase JWT.
 *
 * Shape (docs/identity-consolidation-plan.md 2.1), namespaced per environment
 * so a grant on csms-test is never a grant on production:
 *
 *   app_metadata.csms = {
 *     "test": { "roles": ["tenant-admin", "tenant-viewer"], "tenant_id": "3" },
 *     "prod": { "roles": ["platform-admin", "tenant-viewer"] }
 *   }
 *
 * This box reads only `csms[CSMS_ENV]`. Pure functions, safe to import from
 * the NextAuth options, server actions and route handlers alike.
 */

export const PLATFORM_ROLES = ['admin', 'platform-admin', 'platform-support'] as const;
export const TENANT_ROLES = ['tenant-admin', 'tenant-viewer'] as const;
export const VALID_ROLES: readonly string[] = [...PLATFORM_ROLES, ...TENANT_ROLES];

/** Canonical roles written into a non-empty grant. The console uses Hasura's
 * built-in admin role for explicit platform administrators; tenant roles and
 * platform-support never gain that capability. Unknown roles remain present
 * so the writer's validation still rejects them.
 */
export function normalizeCsmsGrantRoles(roles: readonly string[]): string[] {
  if (roles.length === 0) return [];
  return [
    ...new Set([
      ...roles,
      ...(roles.includes('platform-admin') ? ['admin'] : []),
      ...(roles.some((role) => role !== 'platform-support') ? ['tenant-viewer'] : []),
    ]),
  ];
}

/** Roles allowed to mutate: send OCPP commands, write core data, sync the
 * payment catalog, claim chargers. platform-support and tenant-viewer are
 * read-only. */
export const MUTATING_ROLES: readonly string[] = ['admin', 'platform-admin', 'tenant-admin'];

export const hasAnyRole = (roles: readonly string[] | undefined, allowed: readonly string[]) =>
  Array.isArray(roles) && roles.some((r) => allowed.includes(r));

export const hasPlatformRole = (roles: readonly string[] | undefined) =>
  hasAnyRole(roles, PLATFORM_ROLES);

export const hasPlatformAdminRole = (roles: readonly string[] | undefined) =>
  hasAnyRole(roles, ['admin', 'platform-admin']);

/** Tenant business information requires an explicit tenant or administrator role. */
export const hasTenantAccess = (roles: readonly string[] | undefined) =>
  hasAnyRole(roles, ['admin', 'platform-admin', ...TENANT_ROLES]);

export const validTenantId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value);

export const hasFleetAccess = (claims: CsmsClaims | null | undefined): boolean =>
  !!claims &&
  (hasPlatformRole(claims.roles) ||
    (hasAnyRole(claims.roles, TENANT_ROLES) && validTenantId(claims.tenantId)));

export interface CsmsClaims {
  roles: string[];
  /** Present for every tenant user, and for platform staff who have a home
   * tenant. Absent only for platform staff without one. */
  tenantId?: string;
}

/**
 * Validate and extract this environment's CSMS claims from a decoded Supabase
 * access token. Returns null when the user has no access here, which the
 * callers translate into "sign-in refused" / "session invalidated".
 *
 * Rule:
 *  - `csms[env]` must exist (no subtree for this box = no access here);
 *  - `roles` must be a non-empty array whose members are all valid roles;
 *  - a user with NO platform role must have a non-empty string `tenant_id`;
 *  - a `tenant_id` that is present is always kept (platform staff may have a
 *    home tenant, e.g. roles [tenant-admin, tenant-viewer, platform-support]
 *    with tenant_id "3").
 */
export function readCsmsClaims(claims: unknown, env: string | undefined): CsmsClaims | null {
  if (!env) return null;
  const appMeta = (claims as { app_metadata?: unknown } | null)?.app_metadata;
  if (!appMeta || typeof appMeta !== 'object') return null;
  const csms = (appMeta as { csms?: unknown }).csms;
  if (!csms || typeof csms !== 'object') return null;
  const scoped = (csms as Record<string, unknown>)[env];
  if (!scoped || typeof scoped !== 'object') return null;

  const rawRoles = (scoped as { roles?: unknown }).roles;
  if (!Array.isArray(rawRoles) || rawRoles.length === 0) return null;
  if (!rawRoles.every((r) => typeof r === 'string' && VALID_ROLES.includes(r))) return null;
  const roles = [...new Set(rawRoles as string[])];

  const rawTenant = (scoped as { tenant_id?: unknown }).tenant_id;
  const tenantId =
    typeof rawTenant === 'string' && rawTenant.trim() !== '' ? rawTenant.trim() : undefined;

  if (tenantId && !validTenantId(tenantId)) return null;
  if (!hasPlatformRole(roles) && !tenantId) return null;

  return tenantId && hasTenantAccess(roles) ? { roles, tenantId } : { roles };
}
