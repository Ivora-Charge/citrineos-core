// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use strict';

/**
 * AuditLogs (multi-tenant rollout Phase 3): who did what, to which tenant's
 * what, when. Written by operator-ui server actions (user invites, tenant
 * changes, payment-config syncs, OCPP commands issued from the UI) so support
 * can answer "who rebooted this charger / changed this price" later.
 * Append-only by convention: no update/delete path is exposed.
 */

/** @type {import('sequelize-cli').Migration} */
import { DataTypes, QueryInterface } from 'sequelize';

export default {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.createTable('AuditLogs', {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      // Who: Keycloak username/email + the roles they held at the time.
      actor: { type: DataTypes.STRING, allowNull: false },
      actorRoles: { type: DataTypes.STRING, allowNull: true },
      // Which tenant the action targeted (null for platform-level actions).
      tenantId: { type: DataTypes.INTEGER, allowNull: true },
      // What: short machine-readable action name, e.g. "tenant.invite-user",
      // "payment.sync-tariff", plus a human-readable target.
      action: { type: DataTypes.STRING, allowNull: false },
      target: { type: DataTypes.STRING, allowNull: true },
      // Free-form context (request summary, ids, results). Never store secrets.
      detail: { type: DataTypes.JSONB, allowNull: true },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    });
    await queryInterface.addIndex('AuditLogs', ['tenantId']);
    await queryInterface.addIndex('AuditLogs', ['action']);
    await queryInterface.addIndex('AuditLogs', ['createdAt']);
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.dropTable('AuditLogs');
  },
};
