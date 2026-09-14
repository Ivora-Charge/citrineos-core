// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

/** Authenticated core gateway. Customer operations are explicitly allowlisted,
 * checked against current grants, and pinned to a charger owned by that tenant.
 * Core REST is private; the gateway never forwards a caller's credentials. */

import { type NextRequest, NextResponse } from 'next/server';
import config from '@lib/utils/config';
import { audit } from '@lib/server/audit';
import { AuthUnavailableError, getCsmsSession } from '@lib/server/session';
import { authorizeCoreRequest } from '@lib/utils/core-access';
import { hasuraAdmin } from '@lib/server/hasura';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ path: string[] }> };

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function problem(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

async function handle(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const method = req.method.toUpperCase();

  // 1. Session: the Supabase session in the shared SSO cookie, signature
  //    verified and claims validated by @lib/server/session.
  let session;
  try {
    session = await getCsmsSession();
  } catch (err) {
    if (err instanceof AuthUnavailableError) return problem(503, 'Authentication unavailable');
    throw err;
  }
  if (!session) {
    return problem(401, 'Unauthenticated');
  }
  const roles = session.user.roles;
  const sessionTenantId = session.user.tenantId;
  const { path } = await ctx.params;
  const segments = Array.isArray(path) ? path : [];
  const contentType = req.headers.get('content-type') ?? undefined;
  let rawBody: string | undefined;
  let parsed: unknown;
  if (method !== 'GET' && method !== 'HEAD') {
    rawBody = await req.text();
    if (!rawBody) rawBody = undefined;
    if (rawBody) {
      if (rawBody.length > 1_048_576) return problem(413, 'Request too large');
      if (!(contentType ?? '').toLowerCase().includes('application/json')) {
        return problem(415, 'JSON content type required');
      }
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return problem(400, 'Malformed JSON body');
      }
    }
  }
  const authorization = authorizeCoreRequest(
    session.user,
    method,
    segments,
    req.nextUrl.searchParams,
    parsed,
  );
  if (!authorization.allowed) return problem(authorization.status, authorization.error);
  if (authorization.station) {
    try {
      const result = await hasuraAdmin<{ ChargingStations: Array<{ id: string }> }>(
        `query OwnedCharger($name: String!, $tenant: Int!) {
          ChargingStations(where: {ocppConnectionName: {_eq: $name}, tenantId: {_eq: $tenant}}, limit: 1) { id }
        }`,
        { name: authorization.station, tenant: Number(authorization.tenantId) },
      );
      if (!result.ChargingStations.length)
        return problem(403, 'Charger is not assigned to your tenant');
    } catch {
      return problem(503, 'Unable to verify charger ownership');
    }
  }
  const relPath = segments.map(encodeURIComponent).join('/');
  const search = req.nextUrl.search;
  const queryTenantId = req.nextUrl.searchParams.get('tenantId');

  // 4. Forward to core over the internal network.
  const base = config.citrineCoreInternalUrl;
  if (!base) {
    console.error('[core-proxy] CITRINE_CORE_INTERNAL_URL is not configured');
    return problem(500, 'Core proxy is not configured');
  }
  const target = `${base.replace(/\/$/, '')}/${relPath}${search}`;

  const headers = new Headers();
  if (contentType) headers.set('content-type', contentType);
  const accept = req.headers.get('accept');
  if (accept) headers.set('accept', accept);

  let status: number | 'error' = 'error';
  let response: NextResponse;
  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: rawBody,
      cache: 'no-store',
      redirect: 'manual',
    });
    status = upstream.status;
    const buf = await upstream.arrayBuffer();
    const outHeaders = new Headers();
    const upstreamType = upstream.headers.get('content-type');
    if (upstreamType) outHeaders.set('content-type', upstreamType);
    response = new NextResponse(
      NULL_BODY_STATUSES.has(upstream.status) || buf.byteLength === 0 ? null : buf,
      { status: upstream.status, headers: outHeaders },
    );
  } catch (err) {
    console.error(`[core-proxy] ${method} /${relPath} failed:`, err);
    response = problem(502, 'Core is unreachable');
  }

  // 5. Audit every mutation (best-effort; audit() never throws).
  if (method !== 'GET' && method !== 'HEAD') {
    const auditTenant =
      queryTenantId && /^\d+$/.test(queryTenantId) ? queryTenantId : sessionTenantId;
    await audit({
      actor: session.user.email || session.user.name || session.user.id || 'unknown',
      actorRoles: roles,
      tenantId: auditTenant && /^\d+$/.test(auditTenant) ? auditTenant : undefined,
      action: 'core.request',
      target: `${method} /${segments.join('/')}`,
      detail: { method, path: `/${segments.join('/')}`, status },
    });
  }

  return response;
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  return handle(req, ctx);
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  return handle(req, ctx);
}

export async function PUT(req: NextRequest, ctx: RouteContext) {
  return handle(req, ctx);
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  return handle(req, ctx);
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { allow: 'GET, POST, PUT, DELETE, OPTIONS' },
  });
}
