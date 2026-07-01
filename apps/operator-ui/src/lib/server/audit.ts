// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

// Append-only audit trail writer (multi-tenant rollout Phase 3). Called from
// server actions after privileged operations so support can answer "who did
// what" later. Writes via the Hasura admin secret; the AuditLogs table has no
// insert permission for any JWT role, so the browser cannot forge entries.
//
// Best-effort by design: an audit failure is logged but never fails the
// underlying action.

import config from '@lib/utils/config';

const AUDIT_MUTATION = `
  mutation AuditInsert($object: AuditLogs_insert_input!) {
    insert_AuditLogs_one(object: $object) { id }
  }
`;

export interface AuditEntry {
  /** Who: username/email from the session. */
  actor: string;
  actorRoles?: string[];
  /** Which tenant the action targeted (omit for platform-level actions). */
  tenantId?: number | string;
  /** Machine-readable action, e.g. "tenant.invite-user", "payment.sync-tariff". */
  action: string;
  /** Human-readable target, e.g. "manager@acme.com", "tariff 3". */
  target?: string;
  /** Context (ids, results). Never put secrets or passwords here. */
  detail?: Record<string, unknown>;
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    const res = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.hasuraAdminSecret
          ? { 'x-hasura-admin-secret': config.hasuraAdminSecret }
          : {}),
      },
      body: JSON.stringify({
        query: AUDIT_MUTATION,
        variables: {
          object: {
            actor: entry.actor,
            actorRoles: entry.actorRoles?.join(',') ?? null,
            tenantId: entry.tenantId != null ? Number(entry.tenantId) : null,
            action: entry.action,
            target: entry.target ?? null,
            detail: entry.detail ?? null,
          },
        },
      }),
      cache: 'no-store',
    });
    const body = await res.json();
    if (body.errors?.length) {
      console.error('[audit] insert failed:', body.errors[0].message);
    }
  } catch (err) {
    console.error('[audit] insert failed:', err);
  }
}
