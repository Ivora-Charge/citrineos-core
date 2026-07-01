// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import React, { useEffect, useState } from 'react';
import { CanAccess, useList } from '@refinedev/core';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, UserCog } from 'lucide-react';

import { Button } from '@lib/client/components/ui/button';
import { Card, CardContent, CardHeader } from '@lib/client/components/ui/card';
import { AccessDeniedFallback } from '@lib/utils/AccessDeniedFallback';
import { ActionType, ResourceType } from '@lib/utils/access.types';
import { AUDIT_LOGS_LIST_QUERY, TENANTS_LIST_QUERY } from '@lib/queries/tenants';
import { ACTING_TENANT_KEY } from '@lib/client/hooks/useTenantId';
import { heading2Style, pageMargin } from '@lib/client/styles/page';
import { buttonIconSize } from '@lib/client/styles/icon';

const mask = (id?: string | null) =>
  !id ? '—' : id === 'platform' ? 'platform (dev)' : `${id.slice(0, 8)}…`;

/** Platform-staff page: every tenant on the platform, with "act as" selection
 * (which tenant the platform user's tenant-scoped screens & creates target). */
export const TenantsList = () => {
  const { push } = useRouter();
  const [actingTenant, setActingTenant] = useState<string | null>(null);

  useEffect(() => {
    setActingTenant(window.localStorage.getItem(ACTING_TENANT_KEY));
  }, []);

  const {
    query: { data, isLoading },
  } = useList<any>({
    resource: ResourceType.TENANTS,
    pagination: { mode: 'off' },
    sorters: [{ field: 'id', order: 'asc' }],
    meta: { gqlQuery: TENANTS_LIST_QUERY },
  });

  const actAs = (id: number, name: string) => {
    window.localStorage.setItem(ACTING_TENANT_KEY, String(id));
    setActingTenant(String(id));
    toast.success(`Now acting as tenant #${id} (${name}). Tenant-scoped pages and new records use this tenant.`);
  };

  // Recent privileged actions (user invites, payment syncs, ...) -- written
  // server-side via the admin secret, readable here by platform staff.
  const {
    query: { data: auditData },
  } = useList<any>({
    resource: 'AuditLogs',
    pagination: { pageSize: 30 },
    sorters: [{ field: 'createdAt', order: 'desc' }],
    meta: { gqlQuery: AUDIT_LOGS_LIST_QUERY },
  });

  return (
    <CanAccess
      resource={ResourceType.TENANTS}
      action={ActionType.LIST}
      fallback={<AccessDeniedFallback />}
    >
      <Card className={pageMargin}>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <h2 className={heading2Style}>Tenants</h2>
            <p className="text-sm text-muted-foreground">
              Property management companies on the platform.
              {actingTenant && (
                <>
                  {' '}
                  Acting as tenant <span className="font-mono">#{actingTenant}</span>.
                </>
              )}
            </p>
          </div>
          <Button variant="success" onClick={() => push('/tenants/new')}>
            <Plus className={buttonIconSize} />
            New tenant
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4">ID</th>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Business</th>
                  <th className="py-2 pr-4">City</th>
                  <th className="py-2 pr-4">Stripe</th>
                  <th className="py-2 pr-4">Onboarded</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {(data?.data ?? []).map((t: any) => (
                  <tr
                    key={t.id}
                    className="border-b cursor-pointer hover:bg-accent/40"
                    onClick={() => push(`/tenants/${t.id}`)}
                  >
                    <td className="py-2 pr-4 font-mono">{t.id}</td>
                    <td className="py-2 pr-4">{t.name}</td>
                    <td className="py-2 pr-4">{t.businessName || '—'}</td>
                    <td className="py-2 pr-4">{t.businessCity || '—'}</td>
                    <td className="py-2 pr-4 font-mono">{mask(t.stripeAccountId)}</td>
                    <td className="py-2 pr-4">{t.paymentOnboardingCompletedAt ? 'yes' : 'no'}</td>
                    <td className="py-2 text-right">
                      <Button
                        size="sm"
                        variant={actingTenant === String(t.id) ? 'success' : 'outline'}
                        onClick={(e) => {
                          e.stopPropagation();
                          actAs(t.id, t.name);
                        }}
                      >
                        <UserCog className={buttonIconSize} />
                        {actingTenant === String(t.id) ? 'acting as' : 'act as'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card className={pageMargin}>
        <CardHeader>
          <h2 className={heading2Style}>Audit log</h2>
          <p className="text-sm text-muted-foreground">
            Recent privileged actions (user invites, payment syncs) recorded server-side.
          </p>
        </CardHeader>
        <CardContent>
          {(auditData?.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No entries yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4">When</th>
                  <th className="py-2 pr-4">Actor</th>
                  <th className="py-2 pr-4">Action</th>
                  <th className="py-2 pr-4">Target</th>
                  <th className="py-2">Tenant</th>
                </tr>
              </thead>
              <tbody>
                {(auditData?.data ?? []).map((a: any) => (
                  <tr key={a.id} className="border-b">
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {new Date(a.createdAt).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4">{a.actor}</td>
                    <td className="py-2 pr-4 font-mono">{a.action}</td>
                    <td className="py-2 pr-4">{a.target || '—'}</td>
                    <td className="py-2 font-mono">{a.tenantId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </CanAccess>
  );
};
