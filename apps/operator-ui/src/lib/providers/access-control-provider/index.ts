// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import {
  ActionType,
  type ListCanReturnType,
  type OperatorCanParams,
} from '@lib/utils/access.types';
import type { AccessControlProvider, CanReturnType } from '@refinedev/core';
import { csmsAccessDenied } from '@lib/utils/csms-access';

/**
 * Configuration options for access provider
 */
export interface AccessProviderConfig<TPermissions = unknown> {
  getPermissions: (params?: Record<string, any>) => Promise<TPermissions | null>;
  getUserRole: (permissions?: TPermissions) => Promise<string | undefined>;
}

/**
 * Simple role-based permission mapping
 */
const ROLE_PERMISSIONS = {
  admin: {
    // Admin has full access to everything
    [ActionType.LIST]: true,
    [ActionType.SHOW]: true,
    [ActionType.CREATE]: true,
    [ActionType.EDIT]: true,
    [ActionType.DELETE]: true,
    [ActionType.ACCESS]: true,
    [ActionType.COMMAND]: true,
  },
  user: {
    // Customize user access as needed; for now has the same permissions as Admin
    [ActionType.LIST]: true,
    [ActionType.SHOW]: true,
    [ActionType.CREATE]: true,
    [ActionType.EDIT]: true,
    [ActionType.DELETE]: true,
    [ActionType.ACCESS]: true,
    [ActionType.COMMAND]: true,
  },
};

/**
 * Resources (or specific actions on them) reserved for Ivora platform staff.
 * Tenant users never see these, regardless of their UI permission tier.
 * Raw session roles (from the Supabase JWT's app_metadata.csms.<env>.roles)
 * are checked, not the collapsed admin/user tier, because the tier can't
 * distinguish a tenant admin from a platform admin. The legacy 'admin' role
 * also qualifies: it is only assigned to platform staff (and the generic dev
 * login), never to tenant users -- see @lib/utils/csms-claims.
 */
const PLATFORM_ROLES = ['platform-admin', 'platform-support', 'admin'];
const PLATFORM_ONLY: Partial<Record<string, ActionType[]>> = {
  // Tenant management: list/create/show/delete are platform surface; EDIT is
  // deliberately absent so tenant admins keep editing their own business
  // profile (/settings/business) -- Hasura row permissions scope that to
  // their own row.
  Tenants: [ActionType.LIST, ActionType.CREATE, ActionType.SHOW, ActionType.DELETE],
  // Platform-wide configuration (/settings/platform): platform staff only, every action.
  PlatformSettings: [
    ActionType.LIST,
    ActionType.SHOW,
    ActionType.CREATE,
    ActionType.EDIT,
    ActionType.DELETE,
  ],
};

export const createAccessProvider = <TPermissions = unknown>(
  config: AccessProviderConfig<TPermissions>,
): AccessControlProvider => {
  const { getPermissions, getUserRole } = config;
  const canDefault = false;
  const defaultReason = 'No explicit permissions defined';

  return {
    can: async (operatorCanParams: OperatorCanParams) => {
      const { resource, action, params } = operatorCanParams;

      const canResponse: CanReturnType | ListCanReturnType = {
        can: canDefault,
        reason: defaultReason,
      };

      const permissions = await getPermissions();

      if (!permissions) {
        return canResponse;
      }

      const denied = csmsAccessDenied((permissions as any)?.roles ?? [], resource, action);
      if (denied) return { can: false, reason: denied };

      const platformOnlyActions = resource ? PLATFORM_ONLY[resource] : undefined;
      if (platformOnlyActions?.includes(action as ActionType)) {
        const rawRoles: string[] = (permissions as any)?.roles ?? [];
        if (!rawRoles.some((r) => PLATFORM_ROLES.includes(r))) {
          return {
            can: false,
            reason: `Resource '${resource}' (${action}) is restricted to platform staff`,
          };
        }
      }

      const userRole = await getUserRole(permissions);

      if (!userRole) {
        return {
          can: false,
          reason: 'User has no valid role assigned',
        };
      }

      const rolePermissions = ROLE_PERMISSIONS[userRole as keyof typeof ROLE_PERMISSIONS];

      if (!rolePermissions) {
        return {
          can: false,
          reason: `Unknown role '${userRole}'`,
        };
      }

      // Check basic action permissions
      const hasPermission = rolePermissions[action as ActionType];

      if (hasPermission === false) {
        return {
          can: false,
          reason: `Role '${userRole}' does not have permission for action '${action}'`,
        };
      }

      return {
        can: hasPermission,
        reason: hasPermission
          ? undefined
          : `Role '${userRole}' does not have permission for action '${action}'`,
      };
    },
  };
};
