// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import React, { useState } from 'react';
import { CanAccess, useCreate } from '@refinedev/core';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ChevronLeft } from 'lucide-react';

import { Button } from '@lib/client/components/ui/button';
import { Card, CardContent, CardHeader } from '@lib/client/components/ui/card';
import { Input } from '@lib/client/components/ui/input';
import { AccessDeniedFallback } from '@lib/utils/AccessDeniedFallback';
import { ActionType, ResourceType } from '@lib/utils/access.types';
import { TENANT_CREATE_MUTATION } from '@lib/queries/tenants';
import { heading2Style, pageMargin } from '@lib/client/styles/page';
import { cardHeaderFlex } from '@lib/client/styles/card';

/** Platform-staff page: create a tenant (a property management company).
 * Business/payment details are filled by the tenant's own admin in the
 * onboarding wizard after their first login. */
export const TenantCreate = () => {
  const { push, back } = useRouter();
  const [name, setName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const {
    mutate: create,
    mutation: { isPending },
  } = useCreate();

  const submit = () => {
    if (!name.trim()) {
      toast.error('Tenant name is required');
      return;
    }
    const now = new Date().toISOString();
    create(
      {
        resource: ResourceType.TENANTS,
        values: {
          name: name.trim(),
          businessName: businessName.trim() || null,
          createdAt: now,
          updatedAt: now,
        },
        meta: { gqlMutation: TENANT_CREATE_MUTATION },
        successNotification: false,
      },
      {
        onSuccess: (res) => {
          const id = (res?.data as any)?.id;
          toast.success(`Tenant created (#${id}). Invite its admin from the tenant page.`);
          push(id ? `/tenants/${id}` : '/tenants');
        },
        onError: (err) => toast.error(`Failed to create tenant: ${err.message}`),
      },
    );
  };

  return (
    <CanAccess
      resource={ResourceType.TENANTS}
      action={ActionType.CREATE}
      fallback={<AccessDeniedFallback />}
    >
      <Card className={pageMargin}>
        <CardHeader>
          <div className={cardHeaderFlex}>
            <ChevronLeft onClick={() => back()} className="cursor-pointer" />
            <h2 className={heading2Style}>New tenant</h2>
          </div>
        </CardHeader>
        <CardContent className="max-w-xl flex flex-col gap-4">
          <div>
            <label className="text-sm font-medium">Tenant name *</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sunrise Properties"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Business name</label>
            <Input
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="Legal name (optional, editable later)"
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={submit} disabled={isPending}>
              Create tenant
            </Button>
          </div>
        </CardContent>
      </Card>
    </CanAccess>
  );
};
