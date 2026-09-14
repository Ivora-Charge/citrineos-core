// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CanAccess, useOne } from '@refinedev/core';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ChevronLeft, UserPlus } from 'lucide-react';

import { Button } from '@lib/client/components/ui/button';
import { Card, CardContent, CardHeader } from '@lib/client/components/ui/card';
import { Input } from '@lib/client/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@lib/client/components/ui/select';
import { AccessDeniedFallback } from '@lib/utils/AccessDeniedFallback';
import { ActionType, ResourceType } from '@lib/utils/access.types';
import { TENANT_GET_QUERY } from '@lib/queries/tenants';
import {
  inviteUserAction,
  listTenantUsersAction,
  type InviteUserResult,
  type TenantUser,
} from '@lib/server/actions/tenantUsers';
import { heading2Style, heading3Style, pageMargin } from '@lib/client/styles/page';
import { cardHeaderFlex } from '@lib/client/styles/card';
import { buttonIconSize } from '@lib/client/styles/icon';

const INVITE_ROLES = [
  { value: 'tenant-admin', label: 'Tenant admin (pricing, settings, invites)' },
  { value: 'tenant-viewer', label: 'Regular tenant access (view only)' },
];

/** Platform-staff page: one tenant's profile + the Supabase users whose CSMS
 * claims bind them to it, with invite support (Supabase invite email; the
 * user sets a password on analytics.ivoracharge.com, then signs in here). */
export const TenantDetail = () => {
  const { id } = useParams<{ id: string }>();
  const { back } = useRouter();

  const {
    query: { data: tenantData },
  } = useOne<any>({
    resource: ResourceType.TENANTS,
    id,
    meta: { gqlQuery: TENANT_GET_QUERY },
  });
  const tenant = tenantData?.data;

  const [users, setUsers] = useState<TenantUser[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const loadUsers = useCallback(async () => {
    const res = await listTenantUsersAction(String(id));
    if (res.success) {
      setUsers(res.data);
      setUsersError(null);
    } else {
      setUsersError(res.error);
    }
  }, [id]);
  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('tenant-admin');
  const [inviting, setInviting] = useState(false);
  const [issued, setIssued] = useState<InviteUserResult | null>(null);

  const invite = async () => {
    if (!email.trim()) {
      toast.error('Email is required');
      return;
    }
    setInviting(true);
    try {
      const res = await inviteUserAction({ email: email.trim(), role, tenantId: String(id) });
      if (!res.success) {
        toast.error(`Invite failed: ${res.error}`);
        return;
      }
      setIssued(res.data);
      setEmail('');
      await loadUsers();
    } finally {
      setInviting(false);
    }
  };

  return (
    <CanAccess
      resource={ResourceType.TENANTS}
      action={ActionType.SHOW}
      fallback={<AccessDeniedFallback />}
    >
      <Card className={pageMargin}>
        <CardHeader>
          <div className={cardHeaderFlex}>
            <ChevronLeft onClick={() => back()} className="cursor-pointer" />
            <h2 className={heading2Style}>
              Tenant #{id} — {tenant?.name ?? '…'}
            </h2>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-8">
          <section>
            <h3 className={heading3Style}>Business profile</h3>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm max-w-2xl">
              <span className="text-muted-foreground">Business name</span>
              <span>{tenant?.businessName || '—'}</span>
              <span className="text-muted-foreground">Address</span>
              <span>
                {[tenant?.businessAddress, tenant?.businessCity, tenant?.businessState]
                  .filter(Boolean)
                  .join(', ') || '—'}
              </span>
              <span className="text-muted-foreground">Contact</span>
              <span>
                {[tenant?.businessContactEmail, tenant?.businessContactPhone]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </span>
              <span className="text-muted-foreground">Stripe account</span>
              <span className="font-mono">{tenant?.stripeAccountId || '—'}</span>
              <span className="text-muted-foreground">Payment onboarding</span>
              <span>{tenant?.paymentOnboardingCompletedAt ? 'complete' : 'pending'}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              The tenant&apos;s own admin edits these in Settings → Business / the onboarding
              wizard.
            </p>
          </section>

          <section>
            <div className="flex items-center justify-between">
              <h3 className={heading3Style}>Users</h3>
              <Button variant="success" size="sm" onClick={() => setInviteOpen((v) => !v)}>
                <UserPlus className={buttonIconSize} />
                Invite user
              </Button>
            </div>

            {inviteOpen && (
              <div className="border rounded-md p-4 my-3 max-w-xl flex flex-col gap-3">
                <Input
                  type="email"
                  placeholder="person@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Select value={role} onValueChange={setRole}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INVITE_ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex justify-end">
                  <Button onClick={invite} disabled={inviting}>
                    Send invite
                  </Button>
                </div>
                {issued && (
                  <div className="text-sm bg-accent/40 rounded p-3">
                    {issued.emailSent ? (
                      <p>
                        Invitation emailed to <b>{issued.username}</b>. They set a password at
                        analytics.ivoracharge.com, then sign in here.
                      </p>
                    ) : (
                      <p>
                        <b>{issued.username}</b> already had an Ivora account, so no email was sent
                        — access was granted directly. They sign in here with their existing
                        password (set or reset at analytics.ivoracharge.com).
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {usersError ? (
              <p className="text-sm text-destructive">{usersError}</p>
            ) : users === null ? (
              <p className="text-sm text-muted-foreground">Loading users…</p>
            ) : users.length === 0 ? (
              <p className="text-sm text-muted-foreground">No users yet — invite the first one.</p>
            ) : (
              <table className="w-full text-sm mt-2">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4">Email</th>
                    <th className="py-2 pr-4">Roles</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2">Last sign-in</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-b">
                      <td className="py-2 pr-4">{u.email || '—'}</td>
                      <td className="py-2 pr-4 font-mono">{u.roles.join(', ') || '—'}</td>
                      <td className="py-2 pr-4">{u.confirmed ? 'active' : 'invited'}</td>
                      <td className="py-2">
                        {u.lastSignInAt ? new Date(u.lastSignInAt).toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </CardContent>
      </Card>
    </CanAccess>
  );
};
