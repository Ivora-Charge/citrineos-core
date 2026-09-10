// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0

/** Refresh a stale platform-admin token once per browser instance. The role
 * must come from the newly issued, signed token; this never edits local claims.
 * Concurrent data/live/identity requests await the same refresh. A project
 * whose stored grant is still incomplete does not enter a refresh loop.
 */
export function createPlatformRoleRefreshGuard() {
  let attempted = false;
  let pending: Promise<void> | undefined;

  return {
    async refreshIfNeeded(
      roles: readonly string[] | undefined,
      refresh: () => Promise<unknown>,
    ): Promise<boolean> {
      if (!roles?.includes('platform-admin') || roles.includes('admin')) return false;
      if (pending) {
        await pending;
        return true;
      }
      if (attempted) return false;
      attempted = true;
      // SDK failures leave normal session/error handling in charge. Remember
      // the attempt so repeated GraphQL requests cannot hammer the auth API.
      const operation = Promise.resolve().then(refresh).then(() => undefined, () => undefined);
      pending = operation;
      await operation;
      if (pending === operation) pending = undefined;
      return true;
    },
    resetAfterExplicitSignIn(): void {
      attempted = false;
    },
  };
}
