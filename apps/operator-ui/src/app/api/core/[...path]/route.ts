// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Authenticated proxy in front of the CitrineOS core REST API
 * (docs/identity-consolidation-plan.md 2.6).
 *
 * The browser's BaseRestClient is built with NEXT_PUBLIC_CITRINE_CORE_URL set
 * to /api/core, so every core call (/api/core/ocpp/<version>/... and
 * /api/core/data/...) lands here instead of on a public core-api edge. Core
 * runs with localByPass and treats any caller as admin of tenant 1 without
 * ever comparing the tenantId query to anything, so this handler is the
 * authorization boundary:
 *
 *  1. a valid NextAuth session is required (401 otherwise);
 *  2. anything under ocpp/ and any non-GET under data/ needs admin,
 *     platform-admin or tenant-admin; read-only roles (tenant-viewer,
 *     platform-support) may only GET under data/;
 *  3. callers without a platform role must scope every request to their own
 *     tenant: the tenantId query parameter must be present and equal the
 *     session tenant, and a tenantId in the JSON body must match too (403);
 *  4. the request is forwarded to CITRINE_CORE_INTERNAL_URL with the same
 *     method, the raw body and only the Content-Type header -- never the
 *     session cookie or the bearer token;
 *  5. every non-GET is written to the audit log.
 *
 * middleware.ts also covers /api/core/* (redirects without a session); the
 * checks here are the ones that matter and do not rely on it.
 */

import { getToken } from 'next-auth/jwt';
import { type NextRequest, NextResponse } from 'next/server';
import config from '@lib/utils/config';
import { audit } from '@lib/server/audit';
import { hasAnyRole, hasPlatformRole, MUTATING_ROLES, VALID_ROLES } from '@lib/utils/csms-claims';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ path: string[] }> };

const ALLOWED_ROOTS = new Set(['ocpp', 'data']);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function problem(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

async function handle(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const method = req.method.toUpperCase();

  // 1. Session. getToken decrypts the NextAuth JWT cookie; roles/tenantId are
  //    what options.ts validated from the Supabase claims.
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token || token.error === 'RefreshAccessTokenError') {
    return problem(401, 'Unauthenticated');
  }
  const roles: string[] = Array.isArray(token.roles)
    ? (token.roles as unknown[]).filter((r): r is string => typeof r === 'string')
    : [];
  const sessionTenantId =
    typeof token.tenantId === 'string' && token.tenantId.trim() !== ''
      ? token.tenantId.trim()
      : typeof token.tenantId === 'number'
        ? String(token.tenantId)
        : undefined;
  if (!hasAnyRole(roles, VALID_ROLES)) {
    return problem(403, 'No CSMS role');
  }

  // Path. Segments arrive decoded; refuse anything that could re-route on
  // the upstream side once re-joined ('' / '.' / '..'), and only the two
  // roots core actually serves.
  const { path } = await ctx.params;
  const segments = Array.isArray(path) ? path : [];
  if (segments.length === 0 || segments.some((s) => s === '' || s === '.' || s === '..')) {
    return problem(400, 'Invalid path');
  }
  const root = segments[0];
  if (!ALLOWED_ROOTS.has(root)) {
    return problem(404, 'Not found');
  }
  const relPath = segments.map(encodeURIComponent).join('/');

  // 2. Role.
  const mutating = root === 'ocpp' || method !== 'GET';
  if (mutating && !hasAnyRole(roles, MUTATING_ROLES)) {
    return problem(403, 'Insufficient role');
  }

  // Body (read once; forwarded raw).
  const contentType = req.headers.get('content-type') ?? undefined;
  let rawBody: string | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    rawBody = await req.text();
    if (rawBody === '') rawBody = undefined;
  }

  // 3. Tenant scoping for callers without a platform role.
  const search = req.nextUrl.search;
  const queryTenantId = req.nextUrl.searchParams.get('tenantId');
  const platform = hasPlatformRole(roles);
  if (!platform) {
    if (!sessionTenantId) {
      return problem(403, 'Session has no tenant');
    }
    if (queryTenantId === null || queryTenantId.trim() !== sessionTenantId) {
      return problem(403, 'tenantId query parameter must equal your tenant');
    }
    if (rawBody !== undefined && (contentType ?? '').toLowerCase().includes('application/json')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return problem(400, 'Malformed JSON body');
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const bodyTenantId = (parsed as { tenantId?: unknown }).tenantId;
        if (bodyTenantId !== undefined && bodyTenantId !== null) {
          if (String(bodyTenantId) !== sessionTenantId) {
            return problem(403, 'tenantId in body must equal your tenant');
          }
        }
      }
    }
  }

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
      actor:
        (typeof token.email === 'string' && token.email) ||
        (typeof token.name === 'string' && token.name) ||
        token.sub ||
        'unknown',
      actorRoles: roles,
      tenantId: auditTenant && /^\d+$/.test(auditTenant) ? auditTenant : undefined,
      action: 'core.request',
      target: `${method} /${segments.join('/')}`,
      detail: { method, path: `/${segments.join('/')}`, query: search || null, status },
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
