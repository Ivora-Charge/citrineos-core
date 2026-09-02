// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import { createGenericAuthProvider } from '@lib/providers/auth-provider/generic-auth-provider';
import { createKeycloakAuthProvider } from '@lib/providers/auth-provider/keycloak-auth-provider';
import config from '@lib/utils/config';

// The Supabase runtime provider reads the NextAuth session (accessToken /
// roles / tenantId) that options.ts populates from the Supabase JWT. The
// module keeps its historical Keycloak file and export names because
// useTenantId.tsx and authenticated-layout/index.tsx import
// KeycloakUserIdentity from it; there is no Keycloak behind it any more.
const usesNextAuthSession = config.authProvider === 'supabase';

console.log(
  usesNextAuthSession ? 'Supabase Auth Provider configured' : 'Generic Auth Provider configured',
);

export const authProvider = usesNextAuthSession
  ? createKeycloakAuthProvider()
  : createGenericAuthProvider();
