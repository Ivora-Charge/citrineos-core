// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use server';

import { authedAction, type ActionResult } from '@lib/utils/action-guard';
import config from '@lib/utils/config';

export async function getHasuraAdminSecretAction(): Promise<ActionResult<string>> {
  return authedAction<string>(async (_session) => {
    // With Keycloak auth the browser authenticates to Hasura with its own
    // Bearer token + x-hasura-role, and row-level permissions do the scoping.
    // Handing out the admin secret here would let any logged-in user bypass
    // tenancy entirely, so it stays server-side (used by privileged server
    // actions like syncTariffToPayment). The generic dev provider keeps the
    // old behavior for local development.
    if (config.authProvider === 'keycloak') {
      return '';
    }
    return config.hasuraAdminSecret || '';
  });
}
