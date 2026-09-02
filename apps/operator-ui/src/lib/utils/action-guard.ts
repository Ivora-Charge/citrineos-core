// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { hasAnyRole, hasPlatformRole } from '@lib/utils/csms-claims';
import { AuthUnavailableError, getCsmsSession, type CsmsSession } from '@lib/server/session';

/** The verified caller of a server action (see @lib/server/session). */
export type AuthedSession = CsmsSession;

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
    // No session, an expired refresh token, invalid claims or a billing block
    // all come back as null: the caller has to sign in again.
    session = await getCsmsSession();
  } catch (err) {
    if (err instanceof AuthUnavailableError) {
      return { success: false, error: 'Authentication service unavailable', code: 'ERROR' };
    }
    return {
      success: false,
      error: 'Failed to retrieve session',
      code: 'ERROR',
    };
  }

  if (!session?.user) {
    return { success: false, error: 'Unauthenticated', code: 'UNAUTHORIZED' };
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
