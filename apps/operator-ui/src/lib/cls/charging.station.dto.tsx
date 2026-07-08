// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type {
  ChargingStationCapabilityEnumType,
  ChargingStationDto,
  ChargingStationParkingRestrictionEnumType,
  ConnectorDto,
  ConnectorStatusEnumType,
  EvseDto,
  LocationDto,
  StatusNotificationDto,
} from '@citrineos/base';
import {
  ChargingStationSchema,
  LocationSchema,
  OCPP2_0_1,
  StatusNotificationSchema,
  TransactionSchema,
} from '@citrineos/base';
import { Expose } from 'class-transformer';
import { IsBoolean } from 'class-validator';
import type { Point } from 'geojson';
import { z } from 'zod';

const ChargingStationDetailsSchema = ChargingStationSchema.extend({
  location: LocationSchema.omit({ chargingPool: true }).optional(),
  statusNotifications: z.array(StatusNotificationSchema).optional(),
  transactions: z.array(TransactionSchema.omit({ station: true, location: true })).optional(),
});

export const ChargingStationDetailsProps = ChargingStationDetailsSchema.keyof().enum;

export type ChargingStationDetailsDto = z.infer<typeof ChargingStationDetailsSchema>;

const ChargingStationStatusCountsSchema = ChargingStationSchema.extend({
  statusNotifications: z.array(StatusNotificationSchema).optional(),
});

export type ChargingStationStatusCountsDto = z.infer<typeof ChargingStationStatusCountsSchema>;

export class ChargingStationClass implements Partial<ChargingStationDto> {
  id!: number;
  ocppConnectionName!: string;
  @IsBoolean()
  isOnline!: boolean;
  protocol?: any;
  chargePointVendor?: string | null;
  chargePointModel?: string | null;
  chargePointSerialNumber?: string | null;
  chargeBoxSerialNumber?: string | null;
  firmwareVersion?: string | null;
  iccid?: string | null;
  imsi?: string | null;
  meterType?: string | null;
  meterSerialNumber?: string | null;
  coordinates?: Point | null;
  floorLevel?: string | null;
  parkingRestrictions?: ChargingStationParkingRestrictionEnumType[] | null;
  capabilities?: ChargingStationCapabilityEnumType[] | null;
  locationId?: number | null;
  @Expose({ name: 'StatusNotifications' })
  statusNotifications?: StatusNotificationDto[] | null;
  evses?: EvseDto[] | null;
  connectors?: ConnectorDto[] | null;
  // TODO: Add missing properties from ChargingStationDto
  location?: LocationDto;
  networkProfiles?: any;
  transactions?: any[] | null;
}

// TODO: Add missing enums and types for local use
export enum ChargingStationStatus {
  CHARGING = 'CHARGING',
  CHARGING_SUSPENDED = 'CHARGING_SUSPENDED',
  AVAILABLE = 'AVAILABLE',
  UNAVAILABLE = 'UNAVAILABLE',
  FAULTED = 'FAULTED',
}

export interface ChargingStationStatusCounts {
  [ChargingStationStatus.CHARGING]: number;
  [ChargingStationStatus.CHARGING_SUSPENDED]: number;
  [ChargingStationStatus.AVAILABLE]: number;
  [ChargingStationStatus.UNAVAILABLE]: number;
  [ChargingStationStatus.FAULTED]: number;
}

export const getChargingStationStatus = (chargingStation: ChargingStationStatusCountsDto) => {
  const counts = getChargingStationStatusCounts(chargingStation);

  if (counts[ChargingStationStatus.FAULTED] > 0) {
    return ChargingStationStatus.FAULTED;
  } else if (counts[ChargingStationStatus.AVAILABLE] > 0) {
    return ChargingStationStatus.AVAILABLE;
  } else if (counts[ChargingStationStatus.CHARGING_SUSPENDED] > 0) {
    return ChargingStationStatus.CHARGING_SUSPENDED;
  } else if (counts[ChargingStationStatus.UNAVAILABLE] > 0) {
    return ChargingStationStatus.UNAVAILABLE;
  }
};

export const getChargingStationStatusCounts = (chargingStation: ChargingStationStatusCountsDto) => {
  const counts: ChargingStationStatusCounts = {
    [ChargingStationStatus.CHARGING]: 0,
    [ChargingStationStatus.CHARGING_SUSPENDED]: 0,
    [ChargingStationStatus.AVAILABLE]: 0,
    [ChargingStationStatus.UNAVAILABLE]: 0,
    [ChargingStationStatus.FAULTED]: 0,
  };
  // Status notifications arrive in one of two shapes depending on the query:
  // a flat `statusNotifications` array, or nested under
  // `LatestStatusNotifications[].StatusNotification` (what the list/detail
  // queries actually return). Flatten both so the status is computed from the
  // data that is really present -- otherwise `statusNotifications` is empty
  // and every evse falls through to UNAVAILABLE.
  const latestNested = (
    (chargingStation as { LatestStatusNotifications?: Array<{ StatusNotification?: unknown }> })
      ?.LatestStatusNotifications ?? []
  )
    .map((l) => l?.StatusNotification)
    .filter((s): s is StatusNotificationDto => !!s);
  const allStatusNotifications: StatusNotificationDto[] = [
    ...(chargingStation?.statusNotifications ?? []),
    ...latestNested,
  ];

  const evses = chargingStation?.evses;
  if (evses && evses.length > 0) {
    for (const evse of evses) {
      // Match on the OCPP evse id, not the DB primary key. StatusNotification
      // .evseId is the OCPP serial int (1, 2, ...); on the Evse that value is
      // `evseTypeId` ("the serial int used in OCPP 2.0.1 to refer to the
      // EVSE"), NOT `evseId` (the eMI3 string, usually empty) and NOT `id`
      // (the row PK). The previous code compared evseId against the PK and
      // connectorId against evse.connectors?.[0]?.id -- connectors aren't
      // nested on the evse in this query, so that clause never matched and
      // every evse fell through to UNAVAILABLE.
      const evseOcppId = (evse as EvseDto).evseTypeId;
      const notificationsForEvse = allStatusNotifications.filter(
        (sn) => sn?.evseId === evseOcppId,
      );
      // Prefer the most recently updated notification for this evse.
      const latestStatusNotificationForEvse = notificationsForEvse.reduce<
        StatusNotificationDto | undefined
      >((latest, sn) => {
        if (!latest) return sn;
        const a = new Date(sn.timestamp ?? sn.createdAt ?? 0).getTime();
        const b = new Date(latest.timestamp ?? latest.createdAt ?? 0).getTime();
        return a >= b ? sn : latest;
      }, undefined);
      if (latestStatusNotificationForEvse) {
        const connectorStatus: ConnectorStatusEnumType =
          latestStatusNotificationForEvse?.connectorStatus ||
          OCPP2_0_1.ConnectorStatusEnumType.Unavailable;
        switch (connectorStatus) {
          case OCPP2_0_1.ConnectorStatusEnumType.Available:
            counts[ChargingStationStatus.AVAILABLE]++;
            break;
          case OCPP2_0_1.ConnectorStatusEnumType.Occupied: {
            const activeTransaction = (chargingStation as ChargingStationClass)?.transactions?.find(
              (transaction) => transaction.evse?.id === evse.id,
            );
            if (activeTransaction && activeTransaction.isActive) {
              const chargingState = activeTransaction.chargingState;
              if (chargingState === OCPP2_0_1.ChargingStateEnumType.Charging) {
                counts[ChargingStationStatus.CHARGING]++;
              } else {
                counts[ChargingStationStatus.CHARGING_SUSPENDED]++;
              }
            }
            break;
          }
          case OCPP2_0_1.ConnectorStatusEnumType.Faulted:
            counts[ChargingStationStatus.FAULTED]++;
            break;
          case OCPP2_0_1.ConnectorStatusEnumType.Unavailable:
            counts[ChargingStationStatus.UNAVAILABLE]++;
            break;
          case OCPP2_0_1.ConnectorStatusEnumType.Reserved:
          default:
            // no handling
            break;
        }
      } else {
        counts[ChargingStationStatus.UNAVAILABLE]++;
      }
    }
  }
  return counts;
};
