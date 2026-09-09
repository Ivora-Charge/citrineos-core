// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import React, { useEffect, useState } from 'react';
import {
  type ChargingStationDto,
  ChargingStationParkingRestrictionEnum,
  type ChargingStationParkingRestrictionEnumType,
  ChargingStationProps,
  ChargingStationSchema,
  type LocationDto,
  LocationProps,
  OCPPVersion,
  type TariffDto,
} from '@citrineos/base';
import type { MessageConfirmation } from '@lib/utils/MessageConfirmation';
import { triggerMessageAndHandleResponse } from '@lib/utils/messages.utils';
import { useGqlCustom } from '@lib/utils/use-gql-custom';
import { PLATFORM_SETTINGS_LIST_QUERY } from '@lib/queries/platform.settings';
import { zodResolver } from '@hookform/resolvers/zod';
import { Form } from '@lib/client/components/form';
import {
  CheckboxFormField,
  ComboboxFormField,
  FormField,
  formLabelStyle,
  MultiSelectFormField,
} from '@lib/client/components/form/field';
import { Checkbox } from '@lib/client/components/ui/checkbox';
import { Label } from '@lib/client/components/ui/label';
import { MenuSection } from '@lib/client/components/main-menu/main.menu';
import { Input } from '@lib/client/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@lib/client/components/ui/dialog';
import { Combobox } from '@lib/client/components/combobox';
import { AddressAutocomplete } from '@lib/client/components/form/address-autocomplete';
import { ChargingStationClass } from '@lib/cls/charging.station.dto';
import {
  CHARGING_STATIONS_CREATE_MUTATION,
  CHARGING_STATIONS_EDIT_MUTATION,
  CHARGING_STATIONS_GET_QUERY,
} from '@lib/queries/charging.stations';
import { LOCATIONS_CREATE_MUTATION, LOCATIONS_LIST_QUERY } from '@lib/queries/locations';
import {
  CONNECTOR_EDIT_MUTATION,
  GET_CONNECTOR_LIST_FOR_STATION_EVSE,
} from '@lib/queries/connectors';
import { TARIFF_CREATE_MUTATION, TARIFF_LIST_QUERY } from '@lib/queries/tariffs';
import { TENANT_GET_QUERY } from '@lib/queries/tenants';
import { ActionType, ResourceType } from '@lib/utils/access.types';
import { AccessDeniedFallback } from '@lib/utils/AccessDeniedFallback';
import { getSerializedValues } from '@lib/utils/middleware';
import {
  CanAccess,
  type CrudFilter,
  useCreate,
  useList,
  useNotification,
  useOne,
  useSelect,
  useTranslate,
  useUpdate,
} from '@refinedev/core';
import { useForm } from '@refinedev/react-hook-form';
import { debounce } from 'lodash';
import { ChevronDown, ChevronLeft, ChevronRight, UploadIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import z from 'zod';
import { Card, CardContent, CardHeader } from '@lib/client/components/ui/card';
import { cardGridStyle, cardHeaderFlex } from '@lib/client/styles/card';
import { heading2Style, pageMargin } from '@lib/client/styles/page';
import { S3_BUCKET_FOLDER_IMAGES_CHARGING_STATIONS } from '@lib/utils/consts';
import { Field, FieldLabel } from '@lib/client/components/ui/field';
import { Button } from '@lib/client/components/ui/button';
import { buttonIconSize } from '@lib/client/styles/icon';
import { uploadFileViaPresignedUrl } from '@lib/server/actions/file/uploadFileViaPresignedUrl';
import { useTenantId } from '@lib/client/hooks/useTenantId';
import { syncTariffToPaymentAction } from '@lib/server/actions/syncTariffToPayment';

type ChargingStationUpsertProps = {
  params?: { id?: number };
  allowImageUpload?: boolean;
};

// Capabilities were dropped from the form on purpose (2026-08-04): the field
// confused operators and nothing downstream consumes it yet. Existing values
// are untouched -- the mutation only sets submitted fields.
const ChargingStationCreateSchema = ChargingStationSchema.pick({
  [ChargingStationProps.id]: true,
  [ChargingStationProps.ocppConnectionName]: true,
  [ChargingStationProps.locationId]: true,
  [ChargingStationProps.floorLevel]: true,
  [ChargingStationProps.parkingRestrictions]: true,
  [ChargingStationProps.use16StatusNotification0]: true,
}).extend({
  // Seconds between periodic MeterValues during a session. Pushed to the
  // charger on every accepted boot (and live below when it is online).
  // Blank = leave the charger's own value alone.
  // The number input hands the form a string (or '' when emptied); the loaded
  // record hands it a number. handleOnFinish normalises to number | null.
  [ChargingStationProps.meterValueSampleInterval]: z.union([
    z.string().regex(/^\d*$/),
    z.number().int().min(0),
    z.null(),
  ]),
});

const defaultChargingStation = {
  [ChargingStationProps.id]: undefined,
  [ChargingStationProps.ocppConnectionName]: '',
  [ChargingStationProps.locationId]: undefined,
  [ChargingStationProps.floorLevel]: '',
  [ChargingStationProps.parkingRestrictions]: [],
  // 1.6 chargers report per-connector status; keep the station-level id-0
  // StatusNotification mapping ON unless someone flips it under Advanced.
  [ChargingStationProps.use16StatusNotification0]: true,
  [ChargingStationProps.meterValueSampleInterval]: 20,
};

const parkingRestrictions: ChargingStationParkingRestrictionEnumType[] = Object.keys(
  ChargingStationParkingRestrictionEnum,
) as ChargingStationParkingRestrictionEnumType[];

export type ChargingStationCreateDto = z.infer<typeof ChargingStationCreateSchema>;

const emptyNewLocation = {
  name: '',
  address: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
};

// Sentinel values for the two non-tariff rows in the tariff picker.
const TENANT_DEFAULT_TARIFF = -1;
const NEW_TARIFF = -2;

type NewTariffDraft = {
  currency: string;
  pricePerKwh: string;
  pricePerMin: string;
  pricePerSession: string;
  taxRate: string;
  paymentFee: string;
  authorizationAmount: string;
};

const numberOrUndefined = (raw: string): number | undefined => {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
};

export const ChargingStationUpsert = ({
  params,
  allowImageUpload = false,
}: ChargingStationUpsertProps) => {
  const { id } = params || {};
  const searchParams = useSearchParams();
  const locationId = searchParams?.get('locationId');

  const tenantId = useTenantId();

  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [useLocationCoordinates, setUseLocationCoordinates] = useState(true);
  const [latitude, setLatitude] = useState<number | undefined>(undefined);
  const [longitude, setLongitude] = useState<number | undefined>(undefined);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [locationDialogOpen, setLocationDialogOpen] = useState(false);
  const [newLocation, setNewLocation] = useState(emptyNewLocation);
  const [newLocationCoords, setNewLocationCoords] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [creatingLocation, setCreatingLocation] = useState(false);
  const [tariffId, setTariffId] = useState<number | undefined>(undefined);
  const [tariffDialogOpen, setTariffDialogOpen] = useState(false);
  const [creatingTariff, setCreatingTariff] = useState(false);
  const [newTariff, setNewTariff] = useState<NewTariffDraft>({
    currency: '',
    pricePerKwh: '',
    pricePerMin: '',
    pricePerSession: '',
    taxRate: '',
    paymentFee: '',
    authorizationAmount: '',
  });
  const { open } = useNotification();

  const { replace, back } = useRouter();
  const translate = useTranslate();

  const form = useForm({
    refineCoreProps: {
      resource: ResourceType.CHARGING_STATIONS,
      redirect: false,
      mutationMode: 'pessimistic',
      action: id ? 'edit' : 'create',
      meta: {
        gqlQuery: CHARGING_STATIONS_GET_QUERY,
        gqlMutation: id ? CHARGING_STATIONS_EDIT_MUTATION : CHARGING_STATIONS_CREATE_MUTATION,
      },
    },
    defaultValues: defaultChargingStation,
    resolver: zodResolver(ChargingStationCreateSchema),
    warnWhenUnsavedChanges: true,
  });

  // Location search using refine core's useSelect
  const {
    options: locationOptions,
    onSearch,
    query: locationQuery,
  } = useSelect<LocationDto>({
    resource: ResourceType.LOCATIONS,
    optionLabel: 'name',
    optionValue: 'id',
    meta: {
      gqlQuery: LOCATIONS_LIST_QUERY,
      gqlVariables: {
        where: locationId ? { id: { _eq: Number(locationId) } } : {},
        order_by: { updatedAt: 'desc' },
        offset: 0,
        limit: 5,
      },
    },
    pagination: {
      mode: 'off',
    },
    onSearch: (value: string) => {
      const debouncedSearch = debounce((value: string): CrudFilter[] => {
        if (!value) {
          return [];
        }
        const valueList = [
          { field: LocationProps.name, operator: 'contains', value },
          { field: LocationProps.address, operator: 'contains', value },
          { field: LocationProps.city, operator: 'contains', value },
          { field: LocationProps.state, operator: 'contains', value },
          { field: LocationProps.postalCode, operator: 'contains', value },
        ];
        return [
          {
            operator: 'or',
            value: valueList,
          } as CrudFilter,
        ];
      }, 300);

      return debouncedSearch(value) || [];
    },
  });

  const { mutateAsync: createRecord } = useCreate();
  const { mutateAsync: updateConnector } = useUpdate();

  // The station's connectors (edit only): source of the current tariff and
  // the rows a tariff change is written to (tariffs attach per connector).
  const { query: connectorsQuery } = useList({
    resource: ResourceType.CONNECTORS,
    meta: {
      gqlQuery: GET_CONNECTOR_LIST_FOR_STATION_EVSE,
      gqlVariables: { stationId: id ?? 0 },
    },
    pagination: { mode: 'off' },
    queryOptions: { enabled: !!id },
  });
  const connectors = (connectorsQuery.data?.data ?? []) as Array<{
    id: number;
    connectorId?: number;
    tariffId?: number | null;
  }>;

  const { query: tariffQuery } = useList<TariffDto>({
    resource: ResourceType.TARIFFS,
    meta: {
      gqlQuery: TARIFF_LIST_QUERY,
      gqlVariables: {
        order_by: { updatedAt: 'desc' },
        offset: 0,
        limit: 50,
      },
    },
    pagination: { mode: 'off' },
  });

  // Tenant row for its default pricing: powers the "Tenant default" option
  // and prefills the new-tariff dialog.
  const { query: tenantQuery } = useOne({
    resource: ResourceType.TENANTS,
    id: tenantId,
    meta: { gqlQuery: TENANT_GET_QUERY },
    queryOptions: { enabled: !!tenantId },
  });
  const tenant = tenantQuery.data?.data as any;
  const tenantHasDefaults = tenant?.defaultPriceKwh != null && tenant?.defaultCurrency;

  const tariffOptions = [
    ...(tenantHasDefaults
      ? [
          {
            label: `${translate('ChargingStations.upsert.tenantDefaultTariff')} (${tenant.defaultCurrency} ${tenant.defaultPriceKwh}/kWh)`,
            value: TENANT_DEFAULT_TARIFF,
          },
        ]
      : []),
    ...(tariffQuery.data?.data ?? []).map((tariff: TariffDto) => ({
      label: `#${tariff.id} - ${tariff.currency} ${tariff.pricePerKwh}/kWh`,
      value: tariff.id as number,
    })),
    { label: translate('ChargingStations.upsert.newTariff'), value: NEW_TARIFF },
  ];

  const tariffIsMixed =
    connectors.length > 1 && new Set(connectors.map((c) => c.tariffId ?? null)).size > 1;

  // Prefill the tariff select once the connectors arrive (only when they all
  // agree; a mixed station shows a hint instead of silently picking one).
  useEffect(() => {
    if (connectors.length > 0 && !tariffIsMixed && tariffId === undefined) {
      setTariffId(connectors[0].tariffId ?? undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectorsQuery.data]);

  useEffect(() => {
    if (locationId && form) {
      form.setValue(ChargingStationProps.locationId, Number(locationId));
    }
  }, [locationId, form]);

  // New stations start from the platform-wide default sampling interval
  // (PlatformSettings.defaultMeterValueSampleInterval); the hardcoded 20 only
  // covers the moment before that query answers. Never touches an edit form.
  const {
    query: { data: platformSettingsData },
  } = useGqlCustom({ gqlQuery: PLATFORM_SETTINGS_LIST_QUERY } as any);
  useEffect(() => {
    if (id) return;
    const rows: Array<{ key: string; value: string | null }> =
      platformSettingsData?.data?.PlatformSettings ?? [];
    const raw = rows.find((r) => r.key === 'defaultMeterValueSampleInterval')?.value;
    if (raw === undefined || raw === null || raw.trim() === '') return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    if (form.getFieldState(ChargingStationProps.meterValueSampleInterval).isDirty) return;
    form.setValue(ChargingStationProps.meterValueSampleInterval, parsed);
  }, [id, platformSettingsData, form]);

  // Initialize coordinates from station data when editing
  useEffect(() => {
    const station = form.refineCore.query?.data?.data;
    if (station && id) {
      const coords = (station as any).coordinates;
      if (coords) {
        setLatitude(coords.coordinates[1]);
        setLongitude(coords.coordinates[0]);
        setUseLocationCoordinates(false);
      } else {
        setUseLocationCoordinates(true);
      }
    }
  }, [form.refineCore.query?.data?.data, id]);

  // Update coordinates when location changes and useLocationCoordinates is true
  useEffect(() => {
    if (useLocationCoordinates && locationOptions) {
      const selectedLocationId = form.getValues(ChargingStationProps.locationId);
      const selectedLocation = locationQuery.data?.data?.find(
        (loc: LocationDto) => loc.id === selectedLocationId,
      );
      if (selectedLocation?.coordinates) {
        setLatitude(selectedLocation.coordinates.coordinates[1]);
        setLongitude(selectedLocation.coordinates.coordinates[0]);
      }
    }
  }, [useLocationCoordinates, locationOptions, form, locationQuery.data?.data]);

  const handleCreateLocation = async () => {
    if (newLocation.name.trim().length < 2) {
      toast.error(translate('ChargingStations.upsert.locationNameRequired'));
      return;
    }
    setCreatingLocation(true);
    try {
      const now = new Date().toISOString();
      const result = await createRecord({
        resource: ResourceType.LOCATIONS,
        values: {
          name: newLocation.name.trim(),
          address: newLocation.address.trim() || null,
          city: newLocation.city.trim() || null,
          state: newLocation.state.trim() || null,
          postalCode: newLocation.postalCode.trim() || null,
          country: newLocation.country.trim() || null,
          // From the Google place selection; the station inherits these when
          // "use location coordinates" is on (the default).
          coordinates: newLocationCoords
            ? {
                type: 'Point',
                coordinates: [newLocationCoords.lng, newLocationCoords.lat],
              }
            : null,
          tenantId,
          createdAt: now,
          updatedAt: now,
        },
        meta: { gqlMutation: LOCATIONS_CREATE_MUTATION },
        successNotification: false,
      });
      const newId = (result?.data as any)?.id as number | undefined;
      if (newId) {
        await locationQuery.refetch();
        form.setValue(ChargingStationProps.locationId, newId, { shouldDirty: true });
        toast.success(translate('ChargingStations.upsert.locationCreated'));
        setLocationDialogOpen(false);
        setNewLocation(emptyNewLocation);
        setNewLocationCoords(null);
      }
    } catch (err: any) {
      toast.error(`${translate('ChargingStations.upsert.locationCreateFailed')}: ${err.message}`);
    } finally {
      setCreatingLocation(false);
    }
  };

  const createTariffRow = async (values: {
    currency: string;
    pricePerKwh: number;
    pricePerMin?: number;
    pricePerSession?: number;
    taxRate?: number;
    paymentFee?: number;
    authorizationAmount?: number;
  }): Promise<number | undefined> => {
    const now = new Date().toISOString();
    const result = await createRecord({
      resource: ResourceType.TARIFFS,
      values: { ...values, tenantId, createdAt: now, updatedAt: now },
      meta: { gqlMutation: TARIFF_CREATE_MUTATION },
      successNotification: false,
    });
    const newId = (result?.data as any)?.id as number | undefined;
    if (newId) tariffQuery.refetch();
    return newId;
  };

  const handleCreateTariff = async () => {
    const currency = newTariff.currency.trim().toLowerCase();
    const pricePerKwh = numberOrUndefined(newTariff.pricePerKwh);
    if (currency.length !== 3) {
      toast.error(translate('ChargingStations.upsert.tariffCurrencyRequired'));
      return;
    }
    if (pricePerKwh === undefined) {
      toast.error(translate('ChargingStations.upsert.tariffPriceRequired'));
      return;
    }
    setCreatingTariff(true);
    try {
      const newId = await createTariffRow({
        currency,
        pricePerKwh,
        pricePerMin: numberOrUndefined(newTariff.pricePerMin),
        pricePerSession: numberOrUndefined(newTariff.pricePerSession),
        taxRate: numberOrUndefined(newTariff.taxRate),
        paymentFee: numberOrUndefined(newTariff.paymentFee),
        authorizationAmount: numberOrUndefined(newTariff.authorizationAmount),
      });
      if (newId) {
        setTariffId(newId);
        setTariffDialogOpen(false);
        toast.success(translate('ChargingStations.upsert.tariffCreated'));
      }
    } catch (err: any) {
      toast.error(`${translate('ChargingStations.upsert.tariffCreateFailed')}: ${err.message}`);
    } finally {
      setCreatingTariff(false);
    }
  };

  // "Tenant default": reuse a tariff that already matches the tenant's
  // default pricing, else mint one from it. Keeps repeated picks from
  // piling up identical tariff rows.
  const resolveTenantDefaultTariff = async (): Promise<number | undefined> => {
    if (!tenantHasDefaults) return undefined;
    const wanted = {
      currency: String(tenant.defaultCurrency).toLowerCase(),
      pricePerKwh: Number(tenant.defaultPriceKwh),
      pricePerMin: tenant.defaultPriceMinute ?? undefined,
      pricePerSession: tenant.defaultPriceSession ?? undefined,
      taxRate: tenant.defaultTaxRate ?? undefined,
      paymentFee: tenant.defaultPaymentFee ?? undefined,
      authorizationAmount: tenant.defaultAuthorizationAmount ?? undefined,
    };
    const same = (a: any, b: any) => Number(a ?? 0) === Number(b ?? 0);
    const existing = (tariffQuery.data?.data ?? []).find(
      (t: TariffDto) =>
        String(t.currency).toLowerCase() === wanted.currency &&
        same(t.pricePerKwh, wanted.pricePerKwh) &&
        same((t as any).pricePerMin, wanted.pricePerMin) &&
        same((t as any).pricePerSession, wanted.pricePerSession) &&
        same((t as any).taxRate, wanted.taxRate) &&
        same((t as any).paymentFee, wanted.paymentFee),
    );
    if (existing) return existing.id as number;
    return createTariffRow(wanted);
  };

  // Write the picked tariff to every connector that differs, then push the
  // pricing to the payment service (same follow-up the connector editor does).
  // Returns the tariff id it synced (if any) so the caller can skip re-syncing
  // it in the location follow-up below.
  const applyTariff = async (): Promise<number | undefined> => {
    if (!id || tariffId === undefined || tariffId === NEW_TARIFF) return undefined;
    let effectiveTariffId = tariffId;
    if (tariffId === TENANT_DEFAULT_TARIFF) {
      const resolved = await resolveTenantDefaultTariff();
      if (!resolved) {
        toast.error(translate('ChargingStations.upsert.tariffApplyFailed'));
        return undefined;
      }
      effectiveTariffId = resolved;
    }
    const now = new Date().toISOString();
    const stale = connectors.filter((c) => (c.tariffId ?? undefined) !== effectiveTariffId);
    try {
      for (const connector of stale) {
        await updateConnector({
          resource: ResourceType.CONNECTORS,
          id: connector.id,
          values: { tariffId: effectiveTariffId, updatedAt: now },
          meta: { gqlMutation: CONNECTOR_EDIT_MUTATION },
          successNotification: false,
        });
      }
      if (stale.length > 0) {
        connectorsQuery.refetch();
        const sync = await syncTariffToPaymentAction(effectiveTariffId, {
          tenantIdOverride: String(tenantId),
        });
        if (!sync.success) {
          toast.error(`${translate('ChargingStations.upsert.tariffSyncFailed')}: ${sync.error}`);
        } else if (sync.data.some((r) => !r.ok)) {
          toast.error(translate('ChargingStations.upsert.tariffSyncPartial'));
        } else {
          toast.success(translate('ChargingStations.upsert.tariffApplied'));
        }
        return effectiveTariffId;
      }
    } catch (err: any) {
      toast.error(`${translate('ChargingStations.upsert.tariffApplyFailed')}: ${err.message}`);
    }
    return undefined;
  };

  // A station edit can change the assigned location without touching tariffs;
  // the payment catalog carries the location per EVSE, so re-push every tariff
  // already wired to this station's connectors (skipping the one applyTariff
  // just synced). Best-effort: failures surface as a toast, the save stands.
  const syncStationLocation = async (excludeTariffId?: number) => {
    const tariffIds = [
      ...new Set(
        connectors
          .map((c) => c.tariffId)
          .filter((t): t is number => t != null && t !== excludeTariffId),
      ),
    ];
    for (const tid of tariffIds) {
      const sync = await syncTariffToPaymentAction(tid, {
        tenantIdOverride: String(tenantId),
      });
      if (!sync.success) {
        toast.error(`${translate('ChargingStations.upsert.tariffSyncFailed')}: ${sync.error}`);
      }
    }
  };

  const handleOnFinish = (values: ChargingStationCreateDto) => {
    const now = new Date().toISOString();

    const newItem: any = getSerializedValues({ ...values }, ChargingStationClass);
    {
      const raw = newItem.meterValueSampleInterval;
      newItem.meterValueSampleInterval =
        raw === '' || raw === undefined || raw === null ? null : Number(raw);
    }

    // Handle coordinates
    if (useLocationCoordinates) {
      newItem.coordinates = null;
    } else if (latitude !== undefined && longitude !== undefined) {
      newItem.coordinates = {
        type: 'Point',
        coordinates: [longitude, latitude],
      };
    }

    if (!id) {
      newItem.tenantId = tenantId;
      newItem.createdAt = now;
    }
    newItem.updatedAt = now;

    // Live push: the boot handler re-applies the interval on every reconnect,
    // but an operator editing an online charger expects it to take effect now.
    const existing = form.refineCore.query?.data?.data as ChargingStationDto | undefined;
    const intervalChanged =
      !!id &&
      existing !== undefined &&
      existing.meterValueSampleInterval !== newItem.meterValueSampleInterval;
    const pushIntervalLive = async () => {
      if (
        !intervalChanged ||
        !existing?.isOnline ||
        !existing.ocppConnectionName ||
        newItem.meterValueSampleInterval === null ||
        newItem.meterValueSampleInterval === undefined
      ) {
        return;
      }
      const value = String(newItem.meterValueSampleInterval);
      const identifier = `identifier=${existing.ocppConnectionName}&tenantId=${tenantId}`;
      if (existing.protocol === OCPPVersion.OCPP1_6) {
        await triggerMessageAndHandleResponse<MessageConfirmation[]>({
          translate,
          url: `/configuration/changeConfiguration?${identifier}`,
          data: { key: 'MeterValueSampleInterval', value },
          ocppVersion: OCPPVersion.OCPP1_6,
        });
      } else {
        await triggerMessageAndHandleResponse<MessageConfirmation[]>({
          translate,
          url: `/monitoring/setVariables?${identifier}`,
          data: {
            setVariableData: [
              {
                component: { name: 'SampledDataCtrlr' },
                variable: { name: 'TxUpdatedInterval' },
                attributeValue: value,
              },
            ],
          },
          ocppVersion: (existing.protocol as OCPPVersion) ?? OCPPVersion.OCPP2_0_1,
        });
      }
    };

    form.refineCore.onFinish(newItem).then(async (result) => {
      if (result) {
        const finalStationId = id || (result as any).data?.id;

        await pushIntervalLive().catch((err) => console.error('meter interval push failed', err));

        const appliedTariffId = await applyTariff();
        await syncStationLocation(appliedTariffId);

        // Upload image to S3
        if (uploadedFile && finalStationId) {
          const renamedFileName = `${S3_BUCKET_FOLDER_IMAGES_CHARGING_STATIONS}/${finalStationId}`;
          uploadFileViaPresignedUrl(uploadedFile, renamedFileName)
            .then((result) => {
              if (!result.success) {
                open?.({
                  type: 'error',
                  message: translate('imageUploadFailed'),
                });
              }
            })
            .catch((err: any) => {
              console.error(err);
              open?.({
                type: 'error',
                message: translate('imageUploadFailed'),
              });
            });
        }
        replace(`/${MenuSection.CHARGING_STATIONS}/${finalStationId}`);
      } else if (id) {
        back();
      }
    });
  };

  return (
    <CanAccess
      resource={ResourceType.CHARGING_STATIONS}
      action={ActionType.EDIT}
      fallback={<AccessDeniedFallback />}
      params={{ id }}
    >
      <Card className={pageMargin}>
        <CardHeader>
          <div className={cardHeaderFlex}>
            <ChevronLeft onClick={() => back()} className="cursor-pointer" />
            <h2 className={heading2Style}>
              {translate(`actions.${id ? 'edit' : 'create'}`)}{' '}
              {translate('ChargingStations.chargingStation')}
            </h2>
          </div>
        </CardHeader>
        <CardContent>
          <Form {...form} submitHandler={handleOnFinish}>
            <div className={cardGridStyle}>
              <FormField
                control={form.control}
                label={translate('ChargingStations.columns.name')}
                name={ChargingStationProps.ocppConnectionName}
                required
              >
                <Input />
              </FormField>

              <div className="space-y-1">
                <ComboboxFormField<number, ChargingStationCreateDto>
                  control={form.control}
                  name={ChargingStationProps.locationId}
                  label={translate('ChargingStations.columns.location')}
                  options={locationOptions}
                  onSearch={onSearch}
                  placeholder={translate('ChargingStations.upsert.selectLocation')}
                  isLoading={locationQuery.isLoading}
                  required
                  disabled={!!locationId}
                />
                {!locationId && (
                  <button
                    type="button"
                    className="text-sm font-medium text-primary hover:underline"
                    onClick={() => setLocationDialogOpen(true)}
                  >
                    + {translate('ChargingStations.upsert.newLocation')}
                  </button>
                )}
              </div>

              {/* Tariff: attaches per connector; the picker writes the choice
                  to every connector of the station on save. */}
              {id ? (
                connectors.length > 0 ? (
                  <Field>
                    <FieldLabel>
                      <span className={formLabelStyle}>
                        {translate('ChargingStations.upsert.tariff')}
                      </span>
                    </FieldLabel>
                    <Combobox<number>
                      options={tariffOptions}
                      value={tariffId}
                      onSelect={(value) => {
                        if (value === NEW_TARIFF) {
                          // Prefill the dialog from the tenant defaults so a
                          // fresh tariff starts from sensible numbers.
                          setNewTariff({
                            currency: tenant?.defaultCurrency ?? '',
                            pricePerKwh:
                              tenant?.defaultPriceKwh != null ? String(tenant.defaultPriceKwh) : '',
                            pricePerMin:
                              tenant?.defaultPriceMinute != null
                                ? String(tenant.defaultPriceMinute)
                                : '',
                            pricePerSession:
                              tenant?.defaultPriceSession != null
                                ? String(tenant.defaultPriceSession)
                                : '',
                            taxRate:
                              tenant?.defaultTaxRate != null ? String(tenant.defaultTaxRate) : '',
                            paymentFee:
                              tenant?.defaultPaymentFee != null
                                ? String(tenant.defaultPaymentFee)
                                : '',
                            authorizationAmount:
                              tenant?.defaultAuthorizationAmount != null
                                ? String(tenant.defaultAuthorizationAmount)
                                : '',
                          });
                          setTariffDialogOpen(true);
                          return;
                        }
                        setTariffId(value);
                      }}
                      placeholder={translate('ChargingStations.upsert.selectTariff')}
                      isLoading={tariffQuery.isLoading}
                    />
                    {tariffIsMixed && tariffId === undefined && (
                      <p className="text-xs text-muted-foreground">
                        {translate('ChargingStations.upsert.tariffMixed')}
                      </p>
                    )}
                  </Field>
                ) : (
                  <Field>
                    <FieldLabel>
                      <span className={formLabelStyle}>
                        {translate('ChargingStations.upsert.tariff')}
                      </span>
                    </FieldLabel>
                    <p className="text-sm text-muted-foreground">
                      {translate('ChargingStations.upsert.tariffNoConnectors')}
                    </p>
                  </Field>
                )
              ) : (
                <Field>
                  <FieldLabel>
                    <span className={formLabelStyle}>
                      {translate('ChargingStations.upsert.tariff')}
                    </span>
                  </FieldLabel>
                  <p className="text-sm text-muted-foreground">
                    {translate('ChargingStations.upsert.tariffAfterCreate')}
                  </p>
                </Field>
              )}
            </div>

            {/* Advanced settings, collapsed by default: everything a typical
                operator never needs. In the simple view the 1.6 id-0 status
                mapping stays at its default (on). */}
            <button
              type="button"
              className="mt-6 mb-2 flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              {translate('ChargingStations.upsert.advanced')}
            </button>

            {showAdvanced && (
              <div className={cardGridStyle}>
                <FormField
                  control={form.control}
                  label={translate('ChargingStations.columns.floorLevel')}
                  name={ChargingStationProps.floorLevel}
                >
                  <Input />
                </FormField>

                <MultiSelectFormField<
                  ChargingStationParkingRestrictionEnumType,
                  ChargingStationCreateDto
                >
                  control={form.control}
                  name={ChargingStationProps.parkingRestrictions}
                  label={translate('ChargingStations.columns.parkingRestrictions')}
                  options={parkingRestrictions}
                  placeholder={translate('ChargingStations.upsert.selectParkingRestrictions')}
                  searchPlaceholder={translate('ChargingStations.upsert.searchParkingRestrictions')}
                />

                <CheckboxFormField
                  control={form.control}
                  name={ChargingStationProps.use16StatusNotification0}
                  label={translate('ChargingStations.use16StatusNotification0')}
                />

                <FormField
                  control={form.control}
                  label={translate('ChargingStations.meterValueSampleInterval')}
                  name={ChargingStationProps.meterValueSampleInterval}
                  description={translate('ChargingStations.meterValueSampleIntervalHint')}
                >
                  <Input type="number" min={0} step={1} />
                </FormField>

                {/* Coordinates Section */}
                <Field>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="useLocationCoordinates"
                      checked={useLocationCoordinates}
                      onCheckedChange={(checked) => {
                        setUseLocationCoordinates(checked === true);
                        if (checked) {
                          // Update coordinates from selected location
                          const selectedLocationId = form.getValues(
                            ChargingStationProps.locationId,
                          );
                          const selectedLocation = locationQuery.data?.data?.find(
                            (loc: LocationDto) => loc.id === selectedLocationId,
                          );
                          if (selectedLocation?.coordinates) {
                            setLatitude(selectedLocation.coordinates.coordinates[1]);
                            setLongitude(selectedLocation.coordinates.coordinates[0]);
                          }
                        }
                      }}
                    />
                    <Label htmlFor="useLocationCoordinates">
                      {translate('ChargingStations.upsert.useLocationCoordinates')}
                    </Label>
                  </div>
                </Field>

                <Field>
                  <FieldLabel>
                    <span className={formLabelStyle}>
                      {translate('ChargingStations.upsert.latitude')}
                    </span>
                  </FieldLabel>
                  <Input
                    type="number"
                    step="any"
                    value={latitude ?? ''}
                    onChange={(e) =>
                      setLatitude(e.target.value ? parseFloat(e.target.value) : undefined)
                    }
                    disabled={useLocationCoordinates}
                    placeholder={translate('ChargingStations.upsert.enterLatitude')}
                  />
                </Field>

                <Field>
                  <FieldLabel>
                    <span className={formLabelStyle}>
                      {translate('ChargingStations.upsert.longitude')}
                    </span>
                  </FieldLabel>
                  <Input
                    type="number"
                    step="any"
                    value={longitude ?? ''}
                    onChange={(e) =>
                      setLongitude(e.target.value ? parseFloat(e.target.value) : undefined)
                    }
                    disabled={useLocationCoordinates}
                    placeholder={translate('ChargingStations.upsert.enterLongitude')}
                  />
                </Field>

                {allowImageUpload && (
                  <Field>
                    <FieldLabel>
                      <span className={formLabelStyle}>
                        {translate('ChargingStations.upsert.image')}
                      </span>
                    </FieldLabel>
                    <Input
                      type="file"
                      accept="image/*"
                      id="uploadInput"
                      style={{ display: 'none' }}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;

                        setUploadedFile(file);
                        setUploadedFileName(file.name);
                      }}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => document.getElementById('uploadInput')?.click()}
                    >
                      <UploadIcon className={buttonIconSize} />
                      {translate('buttons.upload')}
                    </Button>
                    {uploadedFileName && (
                      <span className="text-sm text-gray-700">{uploadedFileName}</span>
                    )}
                  </Field>
                )}
              </div>
            )}
          </Form>
        </CardContent>
      </Card>

      {/* Inline "create location" so onboarding a charger never requires a
          detour through the Locations page. Name is enough; the rest can be
          completed later on the location itself. */}
      <Dialog open={locationDialogOpen} onOpenChange={setLocationDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{translate('ChargingStations.upsert.newLocationTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Field>
              <FieldLabel>
                <span className={formLabelStyle}>
                  {translate('ChargingStations.upsert.locationName')} *
                </span>
              </FieldLabel>
              <Input
                value={newLocation.name}
                onChange={(e) => setNewLocation((p) => ({ ...p, name: e.target.value }))}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel>
                <span className={formLabelStyle}>
                  {translate('ChargingStations.upsert.locationAddress')}
                </span>
              </FieldLabel>
              {/* Google Places autocomplete: picking a suggestion fills city/
                  state/postal/country and captures the coordinates. */}
              <AddressAutocomplete
                value={newLocation.address}
                onChangeAction={(val) => setNewLocation((p) => ({ ...p, address: val }))}
                onSelectPlaceAction={(_placeId, details) => {
                  setNewLocation((p) => ({
                    ...p,
                    address: details.address,
                    city: details.city ?? p.city,
                    state: details.state ?? p.state,
                    postalCode: details.postalCode ?? p.postalCode,
                    country: details.countryCode ?? p.country,
                    // A sensible default name for the location; editable.
                    name: p.name || details.address,
                  }));
                  if (details.coordinates) {
                    setNewLocationCoords({
                      lat: details.coordinates.lat,
                      lng: details.coordinates.lng,
                    });
                  }
                }}
              />
            </Field>
            <div className="flex gap-3">
              <Field className="flex-1">
                <FieldLabel>
                  <span className={formLabelStyle}>
                    {translate('ChargingStations.upsert.locationCity')}
                  </span>
                </FieldLabel>
                <Input
                  value={newLocation.city}
                  onChange={(e) => setNewLocation((p) => ({ ...p, city: e.target.value }))}
                />
              </Field>
              <Field className="w-24">
                <FieldLabel>
                  <span className={formLabelStyle}>
                    {translate('ChargingStations.upsert.locationState')}
                  </span>
                </FieldLabel>
                <Input
                  value={newLocation.state}
                  onChange={(e) => setNewLocation((p) => ({ ...p, state: e.target.value }))}
                />
              </Field>
            </div>
            <div className="flex gap-3">
              <Field className="flex-1">
                <FieldLabel>
                  <span className={formLabelStyle}>
                    {translate('ChargingStations.upsert.locationPostalCode')}
                  </span>
                </FieldLabel>
                <Input
                  value={newLocation.postalCode}
                  onChange={(e) => setNewLocation((p) => ({ ...p, postalCode: e.target.value }))}
                />
              </Field>
              <Field className="w-28">
                <FieldLabel>
                  <span className={formLabelStyle}>
                    {translate('ChargingStations.upsert.locationCountry')}
                  </span>
                </FieldLabel>
                <Input
                  value={newLocation.country}
                  onChange={(e) => setNewLocation((p) => ({ ...p, country: e.target.value }))}
                />
              </Field>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setLocationDialogOpen(false)}
              disabled={creatingLocation}
            >
              {translate('buttons.cancel')}
            </Button>
            <Button type="button" onClick={handleCreateLocation} disabled={creatingLocation}>
              {translate('ChargingStations.upsert.createLocation')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Inline "create tariff", prefilled from the tenant defaults. Only
          currency + price/kWh are required; created and selected in place. */}
      <Dialog open={tariffDialogOpen} onOpenChange={setTariffDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{translate('ChargingStations.upsert.newTariffTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex gap-3">
              <Field className="w-32">
                <FieldLabel>
                  <span className={formLabelStyle}>{translate('Tariffs.fields.currency')} *</span>
                </FieldLabel>
                <Input
                  value={newTariff.currency}
                  maxLength={3}
                  placeholder="usd"
                  onChange={(e) => setNewTariff((p) => ({ ...p, currency: e.target.value }))}
                  autoFocus
                />
              </Field>
              <Field className="flex-1">
                <FieldLabel>
                  <span className={formLabelStyle}>
                    {translate('Tariffs.fields.pricePerKwh')} *
                  </span>
                </FieldLabel>
                <Input
                  type="number"
                  step="any"
                  min={0}
                  value={newTariff.pricePerKwh}
                  onChange={(e) => setNewTariff((p) => ({ ...p, pricePerKwh: e.target.value }))}
                />
              </Field>
            </div>
            <div className="flex gap-3">
              <Field className="flex-1">
                <FieldLabel>
                  <span className={formLabelStyle}>{translate('Tariffs.fields.pricePerMin')}</span>
                </FieldLabel>
                <Input
                  type="number"
                  step="any"
                  min={0}
                  value={newTariff.pricePerMin}
                  onChange={(e) => setNewTariff((p) => ({ ...p, pricePerMin: e.target.value }))}
                />
              </Field>
              <Field className="flex-1">
                <FieldLabel>
                  <span className={formLabelStyle}>
                    {translate('Tariffs.fields.pricePerSession')}
                  </span>
                </FieldLabel>
                <Input
                  type="number"
                  step="any"
                  min={0}
                  value={newTariff.pricePerSession}
                  onChange={(e) => setNewTariff((p) => ({ ...p, pricePerSession: e.target.value }))}
                />
              </Field>
            </div>
            <div className="flex gap-3">
              <Field className="flex-1">
                <FieldLabel>
                  <span className={formLabelStyle}>{translate('Tariffs.fields.taxRate')}</span>
                </FieldLabel>
                <Input
                  type="number"
                  step="any"
                  min={0}
                  value={newTariff.taxRate}
                  onChange={(e) => setNewTariff((p) => ({ ...p, taxRate: e.target.value }))}
                />
              </Field>
              <Field className="flex-1">
                <FieldLabel>
                  <span className={formLabelStyle}>{translate('Tariffs.fields.paymentFee')}</span>
                </FieldLabel>
                <Input
                  type="number"
                  step="any"
                  min={0}
                  value={newTariff.paymentFee}
                  onChange={(e) => setNewTariff((p) => ({ ...p, paymentFee: e.target.value }))}
                />
              </Field>
              <Field className="flex-1">
                <FieldLabel>
                  <span className={formLabelStyle}>
                    {translate('Tariffs.fields.authorizationAmount')}
                  </span>
                </FieldLabel>
                <Input
                  type="number"
                  step="any"
                  min={0}
                  value={newTariff.authorizationAmount}
                  onChange={(e) =>
                    setNewTariff((p) => ({ ...p, authorizationAmount: e.target.value }))
                  }
                />
              </Field>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setTariffDialogOpen(false)}
              disabled={creatingTariff}
            >
              {translate('buttons.cancel')}
            </Button>
            <Button type="button" onClick={handleCreateTariff} disabled={creatingTariff}>
              {translate('ChargingStations.upsert.createTariff')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CanAccess>
  );
};
