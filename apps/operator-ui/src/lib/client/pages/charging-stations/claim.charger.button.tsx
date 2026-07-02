// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import React, { useState } from 'react';
import { useInvalidate } from '@refinedev/core';
import { toast } from 'sonner';
import { PackageOpen } from 'lucide-react';

import { Button } from '@lib/client/components/ui/button';
import { Input } from '@lib/client/components/ui/input';
import { claimChargerAction } from '@lib/server/actions/claimCharger';
import { useTenantId } from '@lib/client/hooks/useTenantId';
import { ResourceType } from '@lib/utils/access.types';
import { buttonIconSize } from '@lib/client/styles/icon';

/**
 * "Claim charger" (multi-tenant rollout Phase 4): activate a purchased unit
 * by the serial number printed on it. The charger must be pre-registered in
 * the Ivora Inventory tenant; claiming moves it (and its EVSEs/connectors)
 * into the caller's tenant and re-syncs any tariffs to the payment service.
 * Platform admins claim into the tenant they are acting as.
 */
export const ClaimChargerButton = () => {
  const tenantId = useTenantId();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState(false);
  const [serial, setSerial] = useState('');
  const [busy, setBusy] = useState(false);

  const claim = async () => {
    if (!serial.trim()) {
      toast.error('Enter the serial number printed on the charger');
      return;
    }
    setBusy(true);
    try {
      const res = await claimChargerAction({
        serial: serial.trim(),
        targetTenantId: tenantId,
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success(
        `Charger ${res.data.ocppConnectionName} claimed into tenant #${res.data.tenantId}.`,
      );
      setSerial('');
      setOpen(false);
      await invalidate({ resource: ResourceType.CHARGING_STATIONS, invalidates: ['list'] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {open && (
        <>
          <Input
            autoFocus
            className="w-56"
            placeholder="Serial number (or station id)"
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void claim()}
          />
          <Button onClick={() => void claim()} disabled={busy}>
            Claim
          </Button>
        </>
      )}
      <Button variant="outline" onClick={() => setOpen((v) => !v)}>
        <PackageOpen className={buttonIconSize} />
        {open ? 'Cancel' : 'Claim charger'}
      </Button>
    </div>
  );
};
