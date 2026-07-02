// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use strict';

/**
 * Tenant default pricing (multi-tenant rollout Phase 6): the onboarding
 * wizard's "default tariff" used to live only in client-side form defaults,
 * so it was lost between sessions and unavailable to server-side flows
 * (charger claims, catalog syncs). Persist it on the tenant row.
 */

/** @type {import('sequelize-cli').Migration} */
import { DataTypes, QueryInterface } from 'sequelize';

const DECIMAL_COLUMNS = [
  'defaultPriceKwh',
  'defaultPriceMinute',
  'defaultPriceSession',
  'defaultAuthorizationAmount',
  'defaultTaxRate',
  'defaultPaymentFee',
];

export default {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.addColumn('Tenants', 'defaultCurrency', {
      type: DataTypes.STRING(3),
      allowNull: true,
    });
    for (const column of DECIMAL_COLUMNS) {
      await queryInterface.addColumn('Tenants', column, {
        type: DataTypes.DECIMAL,
        allowNull: true,
      });
    }
  },

  down: async (queryInterface: QueryInterface) => {
    for (const column of DECIMAL_COLUMNS) {
      await queryInterface.removeColumn('Tenants', column);
    }
    await queryInterface.removeColumn('Tenants', 'defaultCurrency');
  },
};
