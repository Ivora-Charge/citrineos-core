// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

// 'supabase' is the only provider that may run on a public box; 'generic' is
// the local-development login (config.ts refuses to start with it in
// production). Keycloak was removed in the identity consolidation (see
// docs/identity-consolidation-plan.md, Phase 1).
export const AuthProviderTypeEnum = z.enum(['supabase', 'generic']);

export type AuthProviderType = z.infer<typeof AuthProviderTypeEnum>;
