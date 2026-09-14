// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import { hasuraAdmin } from '@lib/server/hasura';
import { ForbiddenError, type AuthedSession } from '@lib/utils/action-guard';
import { hasPlatformRole } from '@lib/utils/csms-claims';

/** Object storage keys must identify an existing fleet entity, never a raw
 * bucket path supplied by a client. The database establishes its owner. */
export async function assertImageAccess(session: AuthedSession, key: string): Promise<void> {
  const match = typeof key === 'string' && /^images\/(ChargingStations|Locations)\/([1-9]\d{0,8})$/.exec(key);
  if (!match) throw new ForbiddenError('Invalid image key');
  const field = `${match[1]}_by_pk`;
  const data = await hasuraAdmin<Record<string, { tenantId: number } | null>>(
    `query ImageOwner($id: Int!) { ${field}(id: $id) { tenantId } }`,
    { id: Number(match[2]) },
  );
  const entity = data[field];
  if (!entity || (!hasPlatformRole(session.user.roles) && String(entity.tenantId) !== session.user.tenantId)) {
    throw new ForbiddenError('Image is not available in this tenant');
  }
}
