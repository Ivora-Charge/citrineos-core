// SPDX-License-Identifier: Apache-2.0
import {
  hasAnyRole,
  hasFleetAccess,
  hasPlatformRole,
  hasTenantAccess,
  MUTATING_ROLES,
  type CsmsClaims,
} from './csms-claims';

// Only reviewed station operations are exposed to customer accounts. Generic
// core CRUD endpoints have their own incomplete tenancy checks and stay private.
const commands = new Set([
  'configuration/reset',
  'configuration/changeAvailability',
  'configuration/triggerMessage',
  'configuration/getConfiguration',
  'configuration/changeConfiguration',
  'configuration/dataTransfer',
  'configuration/updateFirmware',
  'evdriver/remoteStartTransaction',
  'evdriver/remoteStopTransaction',
  'evdriver/requestStartTransaction',
  'evdriver/requestStopTransaction',
  'evdriver/unlockConnector',
  'evdriver/clearCache',
  'reporting/getDiagnostics',
  'reporting/getBaseReport',
  'reporting/getLog',
  'reporting/customerInformation',
  'transactions/getTransactionStatus',
]);

export type CoreAuthorization =
  | { allowed: false; status: number; error: string }
  | { allowed: true; tenantId?: string; station?: string };

export function authorizeCoreRequest(
  claims: CsmsClaims,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body?: unknown,
): CoreAuthorization {
  const deny = (error: string, status = 403): CoreAuthorization => ({
    allowed: false,
    status,
    error,
  });
  if (!hasFleetAccess(claims)) return deny('No tenant fleet access assigned');
  if (
    !segments.length ||
    segments.some((s) => !/^[A-Za-z0-9_.-]+$/.test(s) || s === '.' || s === '..')
  ) {
    return deny('Invalid path', 400);
  }
  if (!['ocpp', 'data'].includes(segments[0])) return deny('Not found', 404);
  if ((segments[0] === 'ocpp' || method !== 'GET') && !hasAnyRole(claims.roles, MUTATING_ROLES)) {
    return deny('Insufficient role');
  }
  // Preserve the existing production support policy. Support is read-only
  // unless a separate management role was explicitly granted above.
  if (segments[0] === 'data' && segments[1]?.toLowerCase() === 'tenant' && !hasTenantAccess(claims.roles)) {
    return deny('Tenant and business access is not included in platform support');
  }
  if (hasPlatformRole(claims.roles)) return { allowed: true };
  if (query.getAll('tenantId').length !== 1 || query.get('tenantId') !== claims.tenantId) {
    return deny('tenantId must equal your assigned tenant');
  }
  if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body))) {
    return deny('Expected a JSON object', 400);
  }
  const payload = (body ?? {}) as Record<string, unknown>;
  if (payload.tenantId !== undefined && String(payload.tenantId) !== claims.tenantId)
    return deny('Tenant mismatch');
  const path = segments.join('/');
  let station: unknown;
  const allowedQuery = new Set(['tenantId']);
  if (segments[0] === 'ocpp') {
    if (
      method !== 'POST' ||
      segments.length !== 4 ||
      !['1.6', '2.0.1'].includes(segments[1]) ||
      !commands.has(segments.slice(2).join('/'))
    )
      return deny('Operation requires a platform administrator');
    // Start-with-profile persists caller-provided database identifiers. Enable
    // separately after that persistence path has its own ownership validation.
    if (payload.chargingProfile !== undefined)
      return deny('Charging profiles require a platform administrator');
    allowedQuery.add('identifier');
    station = query.get('identifier');
  } else if (path === 'data/configuration/password' && method === 'POST') {
    station = payload.ocppConnectionName;
  } else if (path === 'data/ocpprouter/connection' && method === 'DELETE') {
    allowedQuery.add('ocppConnectionName');
    station = query.get('ocppConnectionName');
  } else if (path === 'data/configuration/serverNetworkProfile' && method === 'DELETE') {
    allowedQuery.add('ocppConnectionName');
    allowedQuery.add('configurationSlot');
    station = query.get('ocppConnectionName');
    if (
      !query.getAll('configurationSlot').length ||
      query.getAll('configurationSlot').some((s) => !/^\d{1,4}$/.test(s))
    ) {
      return deny('Invalid configuration slots', 400);
    }
  } else {
    return deny('Operation requires a platform administrator');
  }
  for (const key of query.keys()) {
    if (!allowedQuery.has(key) || (key !== 'configurationSlot' && query.getAll(key).length !== 1)) {
      return deny('Unsupported or duplicate query parameter', 400);
    }
  }
  if (
    typeof station !== 'string' ||
    !station ||
    station.length > 200 ||
    /[\s,*/\\]/.test(station) ||
    Array.from(station).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    return deny('One charger identifier is required', 400);
  }
  // Caller must verify this exact charger belongs to this tenant before fetch.
  return { allowed: true, tenantId: claims.tenantId, station };
}
