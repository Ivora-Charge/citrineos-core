// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use strict';

/** @type {import('sequelize-cli').Migration} */
import { DataTypes, QueryInterface } from 'sequelize';

// Seconds between periodic MeterValues during a transaction. Pushed to the
// charger on every accepted boot (1.6 MeterValueSampleInterval, 2.x
// SampledDataCtrlr.TxUpdatedInterval). NULL = leave the charger's own value.
export default {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.addColumn('ChargingStations', 'meterValueSampleInterval', {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 20,
    });
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.removeColumn('ChargingStations', 'meterValueSampleInterval');
  },
};
