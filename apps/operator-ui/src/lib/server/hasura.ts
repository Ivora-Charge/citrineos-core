// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

// Server-side Hasura client using the admin secret (bypasses row-level
// permissions). Import only from server actions that have already enforced
// the caller's role -- never from client code.

import config from '@lib/utils/config';

export async function hasuraAdmin<T = any>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.hasuraAdminSecret
        ? { 'x-hasura-admin-secret': config.hasuraAdminSecret }
        : {}),
    },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`GraphQL request failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new Error(`GraphQL error: ${body.errors[0].message}`);
  }
  return body.data as T;
}
