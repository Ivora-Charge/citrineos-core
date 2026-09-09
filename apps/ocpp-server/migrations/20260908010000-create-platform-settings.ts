// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use strict';

/**
 * PlatformSettings: platform-wide key/value configuration edited by Ivora
 * platform admins in the operator UI (/settings/platform) and read by the
 * core at runtime. Values are strings; the UI's settings registry knows how
 * to render and validate each key. Seeded with every key the core consumes
 * so the page never shows an empty table.
 */

/** @type {import('sequelize-cli').Migration} */
import { DataTypes, QueryInterface, Sequelize } from 'sequelize';

export default {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.createTable('PlatformSettings', {
      key: { type: DataTypes.STRING(100), primaryKey: true, allowNull: false },
      value: { type: DataTypes.TEXT, allowNull: true },
      // Who last saved it (email / username), for support.
      updatedBy: { type: DataTypes.STRING, allowNull: true },
      // Real DB defaults (DataTypes.NOW is a Sequelize-side default only, so
      // rows inserted through Hasura would otherwise need both timestamps).
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });
    const now = new Date();
    await queryInterface.bulkInsert('PlatformSettings', [
      // Seconds between periodic MeterValues; used for new charging stations
      // and for a charger that boots before its ChargingStations row exists.
      { key: 'defaultMeterValueSampleInterval', value: '20', createdAt: now, updatedAt: now },
      // Comma-separated OCPP measurands pushed on every accepted boot
      // (1.6 MeterValuesSampledData / 2.x SampledDataCtrlr.TxUpdatedMeasurands).
      // Empty = leave the charger's own list alone.
      { key: 'meterValuesSampledData', value: '', createdAt: now, updatedAt: now },
    ]);
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.dropTable('PlatformSettings');
  },
};
