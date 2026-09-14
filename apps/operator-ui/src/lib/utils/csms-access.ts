import { hasAnyRole, hasPlatformAdminRole, hasPlatformRole, hasTenantAccess, MUTATING_ROLES } from './csms-claims';

/** Shared UI/page restrictions; Hasura and server actions enforce data access separately. */
export function csmsAccessDenied(
  roles: readonly string[],
  resource: string | undefined,
  action: string,
): string | undefined {
  if (!hasTenantAccess(roles) && !hasPlatformRole(roles)) return 'No tenant fleet access assigned';
  if (resource === 'Tenants') {
    if (!hasTenantAccess(roles)) return 'Tenant access is not included in platform support';
    if (['list', 'show', 'create', 'delete'].includes(action) && !hasPlatformAdminRole(roles)) {
      return 'Tenant management requires a platform administrator';
    }
  }
  if (resource === 'PlatformSettings' && !hasPlatformAdminRole(roles))
    return 'Platform administrators only';
  if (resource === 'OCPPMessages' && !hasAnyRole(roles, [...MUTATING_ROLES, 'platform-support']))
    return 'Raw charger logs require an administrator';
  if (
    ['create', 'edit', 'delete', 'command'].includes(action) &&
    !hasAnyRole(roles, MUTATING_ROLES)
  ) {
    return 'This account has read-only access';
  }
  return undefined;
}

export function csmsPageDenied(roles: readonly string[], pathname: string): boolean {
  if (!hasTenantAccess(roles) && !hasPlatformRole(roles)) return true;
  const within = (path: string) => pathname === path || pathname.startsWith(`${path}/`);
  if (within('/settings/platform') && !hasPlatformAdminRole(roles)) return true;
  if (within('/tenants') || within('/fleet')) {
    return !hasPlatformAdminRole(roles);
  }
  if (within('/settings/business')) {
    return !hasAnyRole(roles, MUTATING_ROLES);
  }
  // Block direct entry to management forms as well as their menu/buttons.
  // Match route shapes so a charger named "edit" can still be viewed.
  if (
    /^\/(charging-stations|locations|authorizations|partners|tariffs)\/(new|[^/]+\/edit)\/?$/.test(
      pathname,
    )
  ) {
    return !hasAnyRole(roles, MUTATING_ROLES);
  }
  return false;
}
