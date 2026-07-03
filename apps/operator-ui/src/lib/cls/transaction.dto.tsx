// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type {
  AuthorizationDto,
  ChargingStationDto,
  ConnectorDto,
  EvseDto,
  LocationDto,
  MeterValueDto,
  StartTransactionDto,
  StopTransactionDto,
  TariffDto,
  TransactionDto,
  TransactionEventDto,
} from '@citrineos/base';

export class TransactionClass implements Partial<TransactionDto> {
  id?: number;
  transactionId!: string;
  ocppConnectionName!: string;
  stationId!: number;
  transactionEvents?: TransactionEventDto[];
  chargingStation?: ChargingStationDto;
  evse?: EvseDto | null;
  evseDatabaseId?: number;
  isActive!: boolean;
  meterValues?: MeterValueDto[];
  startTransaction?: StartTransactionDto;
  stopTransaction?: StopTransactionDto;
  chargingState?: any;
  timeSpentCharging?: number | null;
  totalKwh?: number | null;
  stoppedReason?: any;
  remoteStartId?: number | null;
  totalCost?: number;
  locationId?: number;
  location?: LocationDto;
  evseId?: number;
  connectorId?: number;
  connector?: ConnectorDto | null;
  authorizationId?: number;
  authorization?: AuthorizationDto;
  tariffId?: number;
  tariff?: TariffDto;
  startTime?: string;
  endTime?: string;
  customData?: any;
  // Payment-service revenue for this session (payment_transaction_revenue
  // view via the Hasura Revenue relationship). Amounts in currency subunits.
  revenue?: {
    total_received?: number | null;
    captured_amount?: number | null;
    overage_amount?: number | null;
    currency?: string | null;
    captured_at?: string | null;
  } | null;
}
