// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use strict';

/** @type {import('sequelize-cli').Migration} */
import { DataTypes, QueryInterface } from 'sequelize';

const STRING_COLUMNS = [
  'stripeAccountId',
  'businessName',
  'businessAddress',
  'businessPostalCode',
  'businessCity',
  'businessState',
  'businessCountry',
  'businessContactEmail',
  'businessContactPhone',
];

export default {
  up: async (queryInterface: QueryInterface) => {
    for (const column of STRING_COLUMNS) {
      await queryInterface.addColumn('Tenants', column, {
        type: DataTypes.STRING,
        allowNull: true,
      });
    }
    await queryInterface.addColumn('Tenants', 'paymentOnboardingCompletedAt', {
      type: DataTypes.DATE,
      allowNull: true,
    });
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.removeColumn('Tenants', 'paymentOnboardingCompletedAt');
    for (const column of STRING_COLUMNS) {
      await queryInterface.removeColumn('Tenants', column);
    }
  },
};
