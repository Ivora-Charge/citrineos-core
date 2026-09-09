// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Platform-wide key/value configuration (not tenant-scoped). Edited by
 * platform admins in the operator UI; read by the core at runtime.
 * See migration 20260908010000-create-platform-settings for the seeded keys.
 */
export enum PlatformSettingKey {
  /** Seconds between periodic MeterValues for new / not-yet-known stations. */
  defaultMeterValueSampleInterval = 'defaultMeterValueSampleInterval',
  /** Comma-separated measurands pushed on boot; empty = don't push. */
  meterValuesSampledData = 'meterValuesSampledData',
}

@Table
export class PlatformSetting extends Model {
  static readonly MODEL_NAME: string = 'PlatformSetting';

  @PrimaryKey
  @Column({ type: DataType.STRING(100), allowNull: false })
  declare key: string;

  @Column(DataType.TEXT)
  declare value?: string | null;

  @Column(DataType.STRING)
  declare updatedBy?: string | null;
}
