// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { getServerSession } from 'next-auth';
import authOptions from '@app/api/auth/[...nextauth]/options';
import { type Session } from 'next-auth';
import { hasAnyRole, hasPlatformRole } from '@lib/utils/csms-claims';

export interface AuthedSession extends Session {
  accessToken: string;
  error?: string;
  user: Session['user'] & {
    roles: string[];
    /** Tenant bound to the token. Always set for tenant users; platform staff
     * may or may not have a home tenant (see @lib/utils/csms-claims). */
    tenantId?: string;
  };
}

export type ActionResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: string;
      code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'ERROR';
    };

/** Thrown inside an action body to produce a FORBIDDEN ActionResult. */
export class ForbiddenError extends Error {
  override name = 'ForbiddenError' as const;
}

export async function authedAction<T>(
  fn: (session: AuthedSession) => Promise<T>,
): Promise<ActionResult<T>> {
  let session: AuthedSession | null = null;

  try {
    session = (await getServerSession(authOptions)) as AuthedSession | null;
  } catch {
    return {
      success: false,
      error: 'Failed to retrieve session',
      code: 'ERROR',
    };
  }

  if (!session?.user) {
    return { success: false, error: 'Unauthenticated', code: 'UNAUTHORIZED' };
  }

  // Supabase refresh failed (or the refreshed claims no longer validate) --
  // the token is dead, force re-login.
  if (session.error === 'RefreshAccessTokenError') {
    return { success: false, error: 'Session expired', code: 'UNAUTHORIZED' };
  }

  try {
    return { success: true, data: await fn(session) };
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { success: false, error: err.message, code: 'FORBIDDEN' };
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message, code: 'ERROR' };
  }
}

// -------------------------------------------------------
// Role-gated guards
// -------------------------------------------------------

/** Run the action only when the session holds at least one of `allowedRoles`. */
export async function authedActionWithRoles<T>(
  allowedRoles: readonly string[],
  fn: (session: AuthedSession) => Promise<T>,
): Promise<ActionResult<T>> {
  return authedAction(async (session) => {
    if (!hasAnyRole(session.user.roles, allowedRoles)) {
      throw new ForbiddenError(`Required role: one of ${allowedRoles.join(', ')}`);
    }
    return fn(session);
  });
}

export async function authedActionWithRole<T>(
  requiredRole: string,
  fn: (session: AuthedSession) => Promise<T>,
): Promise<ActionResult<T>> {
  return authedActionWithRoles([requiredRole], fn);
}

// -------------------------------------------------------
// Tenant-scoped guards
// -------------------------------------------------------

/** Ensures the action is called in the context of the tenant the user
 * actually belongs to. */
export async function authedActionForTenant<T>(
  tenantId: string,
  fn: (session: AuthedSession) => Promise<T>,
): Promise<ActionResult<T>> {
  return authedAction(async (session) => {
    if (session.user.tenantId !== tenantId) {
      throw new ForbiddenError('Tenant mismatch');
    }
    return fn(session);
  });
}

/**
 * The tenant a server action acts on.
 *
 * - Tenant users (no platform role) are bound to their session tenant and may
 *   not name another one.
 * - Platform staff may act on any tenant by passing `override`; without it
 *   they act on their own home tenant if the token has one.
 * - Never falls back to config.tenantId: acting on tenant "1" whenever a
 *   session had no tenant was security finding 4 in
 *   docs/identity-consolidation-plan.md. A session with neither a tenant nor
 *   an explicit platform override is refused.
 */
export function resolveActingTenantId(session: AuthedSession, override?: string): string {
  const own = session.user.tenantId?.trim() || undefined;
  const wanted = override?.trim() || undefined;

  if (hasPlatformRole(session.user.roles)) {
    const tenantId = wanted ?? own;
    if (!tenantId) {
      throw new ForbiddenError(
        'Session has no tenant: platform staff must specify the tenant to act on',
      );
    }
    return tenantId;
  }

  if (!own) {
    throw new ForbiddenError('Session has no tenant');
  }
  if (wanted && wanted !== own) {
    throw new ForbiddenError('Tenant users can only act on their own tenant');
  }
  return own;
}
