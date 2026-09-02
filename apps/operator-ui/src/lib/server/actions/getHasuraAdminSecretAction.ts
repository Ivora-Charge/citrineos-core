// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use server';

import { authedAction, type ActionResult } from '@lib/utils/action-guard';
import config from '@lib/utils/config';

export async function getHasuraAdminSecretAction(): Promise<ActionResult<string>> {
  return authedAction<string>(async (_session) => {
    // The browser authenticates to Hasura with its OWN bearer token plus
    // x-hasura-role, and row-level permissions do the scoping. Handing out the
    // admin secret here lets any logged-in user bypass tenancy entirely.
    //
    // This is an ALLOWLIST on purpose. It used to read `if (authProvider ===
    // 'keycloak') return ''` -- a denylist, so every other value leaked the
    // secret, including a value that failed to parse and fell back to
    // 'generic' (config.ts). Only the local dev provider, which has no real
    // token to present, gets it.
    if (config.authProvider === 'generic') {
      return config.hasuraAdminSecret || '';
    }
    return '';
  });
}
