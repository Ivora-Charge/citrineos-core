// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import { authProvider } from '@lib/providers/auth-provider';
import { ResourceType } from '@lib/utils/access.types';
import config from '@lib/utils/config';
import { HasuraHeader } from '@lib/utils/hasura.types';
import dataProviderHasura, {
  GraphQLClient,
  type HasuraDataProviderOptions,
} from '@refinedev/hasura';
import { getHasuraAdminSecretAction } from '@lib/server/actions/getHasuraAdminSecretAction';
import { ACTING_TENANT_KEY } from '@lib/client/hooks/useTenantId';
import { hasPlatformRole } from '@lib/utils/csms-claims';

const requestMiddleware = async (request: any) => {
  const requestHeaders = {
    ...request.headers,
  };

  const hasuraAdminSecret = await getHasuraAdminSecretAction().then((result) =>
    result.success ? result.data : '',
  );

  if (hasuraAdminSecret) {
    console.debug('Authorizing to Hasura via Hasura Admin Secret');
    requestHeaders[HasuraHeader.X_HASURA_ADMIN_SECRET] = hasuraAdminSecret;
  } else if (authProvider) {
    console.debug('Authorizing to Hasura via configured Auth Provider');
    const token = await authProvider.getToken();
    if (token) {
      requestHeaders['Authorization'] = 'Bearer ' + token;
    }
    const hasuraHeaders = await authProvider.getHasuraHeaders();
    if (hasuraHeaders) {
      const hasuraRole = hasuraHeaders.get(HasuraHeader.X_HASURA_ROLE);
      if (hasuraRole) {
        requestHeaders[HasuraHeader.X_HASURA_ROLE] = hasuraRole;
      }
    }
  }
  return {
    ...request,
    headers: requestHeaders,
  };
};

const API_URL = config.apiUrl;

const client = new GraphQLClient(API_URL, {
  requestMiddleware,
});

const hasuraProviderOptions = {
  idType: 'Int',
  namingConvention: 'hasura-default',
};

const dataProvider = dataProviderHasura(client, hasuraProviderOptions as HasuraDataProviderOptions);

dataProvider.getApiUrl = () => {
  return API_URL;
};

// ---------------------------------------------------------------------------
// "Act as tenant" scoping for platform staff.
//
// Tenant users are scoped by Hasura row-level permissions (their JWT carries
// x-hasura-tenant-id), but platform staff query with the admin role and see
// every row — so the tenant selected on the /tenants page ("act as") never
// reached list queries, and every tenant-scoped page showed the whole
// platform regardless. Inject the acting tenant as a tenantId filter here so
// every list respects it, instead of patching each page individually.
// ---------------------------------------------------------------------------

/** Resources that must NOT be scoped to the acting tenant: platform-wide
 * pages, and tables without a tenantId column. */
const PLATFORM_WIDE_RESOURCES = new Set<string>([ResourceType.TENANTS, 'AuditLogs']);

const actingTenantFilter = async (
  resource: string,
): Promise<{ field: string; operator: 'eq'; value: number } | null> => {
  if (typeof window === 'undefined' || PLATFORM_WIDE_RESOURCES.has(resource)) {
    return null;
  }
  const acting = Number(window.localStorage.getItem(ACTING_TENANT_KEY));
  if (!acting) return null;
  try {
    // Tenant users are bound by their token (Hasura scopes them anyway);
    // platform staff act as the selected tenant. Staff query Hasura as
    // `admin`, so this filter is the only thing scoping their lists -- and
    // it must apply even when their token also names a home tenant (the
    // owner accounts carry tenant 1), or "act as" is a no-op for them.
    const identity = (await authProvider?.getIdentity?.()) as
      | { tenantId?: string; roles?: string[] }
      | undefined;
    if (!hasPlatformRole(identity?.roles)) return null;
  } catch {
    return null;
  }
  return { field: 'tenantId', operator: 'eq', value: acting };
};

const baseGetList = dataProvider.getList.bind(dataProvider);
dataProvider.getList = async (params) => {
  const extra = await actingTenantFilter(params.resource);
  if (!extra) return baseGetList(params);
  return baseGetList({
    ...params,
    filters: [...(params.filters ?? []), extra],
  });
};

export default dataProvider;
