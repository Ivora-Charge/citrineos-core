// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { CanAccess, useCustomMutation, useGetIdentity } from '@refinedev/core';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@lib/client/components/ui/button';
import { Card, CardContent, CardHeader } from '@lib/client/components/ui/card';
import { Input } from '@lib/client/components/ui/input';
import { AccessDeniedFallback } from '@lib/utils/AccessDeniedFallback';
import { ActionType, ResourceType, type User } from '@lib/utils/access.types';
import { heading2Style } from '@lib/client/styles/page';
import { useGqlCustom } from '@lib/utils/use-gql-custom';
import {
  PLATFORM_SETTINGS_LIST_QUERY,
  PLATFORM_SETTINGS_UPSERT_MUTATION,
} from '@lib/queries/platform.settings';

/**
 * Platform-wide configuration (PlatformSettings table), for Ivora platform
 * staff only. Values are stored as strings; this registry says how each known
 * key is labelled, rendered and validated. Keys present in the table but not
 * listed here still show up as plain text rows, so a new key seeded by a core
 * migration is editable before the UI learns about it.
 */
interface SettingSpec {
  key: string;
  label: string;
  description: string;
  kind: 'integer' | 'measurands' | 'text';
  placeholder?: string;
}

const KNOWN_SETTINGS: SettingSpec[] = [
  {
    key: 'defaultMeterValueSampleInterval',
    label: 'Default meter sampling interval (seconds)',
    description:
      'Seconds between MeterValues during a session. Used for newly added chargers and for a ' +
      'charger that boots before its record exists. Each charger can override it under ' +
      'Advanced on its edit page. Applied on every accepted boot.',
    kind: 'integer',
    placeholder: '20',
  },
  {
    key: 'meterValuesSampledData',
    label: 'Meter measurands pushed on boot',
    description:
      'Comma-separated OCPP measurands every charger is told to include in its MeterValues ' +
      '(OCPP 1.6 MeterValuesSampledData, OCPP 2.x SampledDataCtrlr.TxUpdatedMeasurands). ' +
      'Example: Energy.Active.Import.Register,Power.Active.Import,Current.Import,Voltage. ' +
      'Leave blank to keep each charger’s own list. Chargers reject measurands they cannot measure.',
    kind: 'measurands',
    placeholder: 'Energy.Active.Import.Register,Power.Active.Import',
  },
];

const MEASURAND_RE = /^[A-Za-z0-9.]+$/;

const validate = (spec: SettingSpec, raw: string): string | null => {
  const value = raw.trim();
  if (spec.kind === 'integer') {
    if (value === '') return null;
    if (!/^\d+$/.test(value)) return 'Must be a whole number of seconds (0 or more).';
    return null;
  }
  if (spec.kind === 'measurands') {
    if (value === '') return null;
    const bad = value
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0)
      .find((m) => !MEASURAND_RE.test(m));
    return bad ? `"${bad}" is not a valid measurand name.` : null;
  }
  return null;
};

const normalize = (spec: SettingSpec, raw: string): string => {
  const value = raw.trim();
  if (spec.kind === 'measurands') {
    return value
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0)
      .join(',');
  }
  return value;
};

interface SettingRow {
  key: string;
  value: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export const PlatformSettings = () => {
  const { data: identity } = useGetIdentity<User>();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const {
    query: { data, isLoading, error, refetch },
  } = useGqlCustom({ gqlQuery: PLATFORM_SETTINGS_LIST_QUERY } as any);
  const rows: SettingRow[] = useMemo(() => data?.data?.PlatformSettings ?? [], [data]);

  const { mutateAsync } = useCustomMutation();

  // Seed the draft from the table once it loads (and after each save).
  useEffect(() => {
    if (!rows.length) return;
    setDraft(Object.fromEntries(rows.map((r) => [r.key, r.value ?? ''])));
  }, [rows]);

  useEffect(() => {
    if (error) toast.error('Could not load platform settings.');
  }, [error]);

  // Known keys first (in registry order), then anything else the table holds.
  const specs: SettingSpec[] = useMemo(() => {
    const known = new Set(KNOWN_SETTINGS.map((s) => s.key));
    const extra = rows
      .filter((r) => !known.has(r.key))
      .map<SettingSpec>((r) => ({ key: r.key, label: r.key, description: '', kind: 'text' }));
    return [...KNOWN_SETTINGS, ...extra];
  }, [rows]);

  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);

  const errors = useMemo(
    () =>
      Object.fromEntries(
        specs.map((s) => [s.key, validate(s, draft[s.key] ?? '')]).filter(([, e]) => e !== null),
      ) as Record<string, string>,
    [specs, draft],
  );

  const changedKeys = specs
    .map((s) => s.key)
    .filter(
      (k) =>
        normalize(specs.find((s) => s.key === k)!, draft[k] ?? '') !==
        (rowByKey.get(k)?.value ?? ''),
    );

  const save = async () => {
    if (Object.keys(errors).length > 0) {
      toast.error('Fix the highlighted values first.');
      return;
    }
    if (changedKeys.length === 0) {
      toast.info('Nothing changed.');
      return;
    }
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const updatedBy = identity?.email || identity?.name || null;
      await mutateAsync({
        url: '', // Required by useCustomMutation, not used for GraphQL
        method: 'post', // Required by useCustomMutation
        values: {}, // Required by useCustomMutation
        meta: {
          gqlMutation: PLATFORM_SETTINGS_UPSERT_MUTATION,
          gqlVariables: {
            objects: changedKeys.map((key) => ({
              key,
              value: normalize(specs.find((s) => s.key === key)!, draft[key] ?? ''),
              updatedBy,
              // createdAt only lands on a brand-new row: on_conflict does not
              // list it in update_columns.
              createdAt: now,
              updatedAt: now,
            })),
          },
        },
        successNotification: false,
        errorNotification: false,
      });
      toast.success(
        `Saved ${changedKeys.length} setting${changedKeys.length === 1 ? '' : 's'}. ` +
          'Chargers pick the new values up on their next boot.',
      );
      await refetch();
    } catch (e: any) {
      toast.error(`Save failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <CanAccess
      resource={ResourceType.PLATFORM_SETTINGS}
      action={ActionType.EDIT}
      fallback={<AccessDeniedFallback />}
    >
      <Card className="m-4 md:m-6">
        <CardHeader>
          <h2 className={heading2Style}>Platform settings</h2>
          <p className="text-sm text-muted-foreground">
            Defaults that apply to every tenant and charger on this platform. Per-charger values,
            where they exist, take precedence.
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {specs.map((spec) => {
                const row = rowByKey.get(spec.key);
                const err = errors[spec.key];
                return (
                  <div key={spec.key} className="flex flex-col gap-1 max-w-2xl">
                    <label htmlFor={`ps-${spec.key}`} className="text-base font-semibold">
                      {spec.label}
                    </label>
                    {spec.description && (
                      <p className="text-sm text-muted-foreground">{spec.description}</p>
                    )}
                    <Input
                      id={`ps-${spec.key}`}
                      type={spec.kind === 'integer' ? 'number' : 'text'}
                      min={spec.kind === 'integer' ? 0 : undefined}
                      step={spec.kind === 'integer' ? 1 : undefined}
                      placeholder={spec.placeholder}
                      value={draft[spec.key] ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [spec.key]: e.target.value }))}
                      aria-invalid={!!err}
                    />
                    {err && <p className="text-sm text-destructive">{err}</p>}
                    <p className="text-xs text-muted-foreground font-mono">
                      {spec.key}
                      {row?.updatedAt
                        ? ` · last saved ${new Date(row.updatedAt).toLocaleString()}${
                            row.updatedBy ? ` by ${row.updatedBy}` : ''
                          }`
                        : ''}
                    </p>
                  </div>
                );
              })}
              <div className="flex gap-3">
                <Button
                  onClick={save}
                  disabled={saving || changedKeys.length === 0 || Object.keys(errors).length > 0}
                >
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save
                </Button>
                <Button
                  variant="outline"
                  disabled={saving || changedKeys.length === 0}
                  onClick={() =>
                    setDraft(Object.fromEntries(rows.map((r) => [r.key, r.value ?? ''])))
                  }
                >
                  Reset
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </CanAccess>
  );
};
