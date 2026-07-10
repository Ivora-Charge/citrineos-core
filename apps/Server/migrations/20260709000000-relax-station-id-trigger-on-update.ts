'use strict';

import { QueryInterface } from 'sequelize';

/**
 * Relax populate_station_id() to only enforce station resolution on INSERT.
 *
 * The trigger (created by 20260427000000-rename-charging-station-columns) fires
 * BEFORE INSERT OR UPDATE whenever NEW."stationId" IS NULL and RAISEs when the
 * ocppConnectionName can't be resolved to a ChargingStations row. That is right
 * for INSERTs (new rows must belong to a station), but it also fires on UPDATEs
 * of historical rows whose station was since deleted — freezing them forever.
 * Observed 2026-07-09: 33 Transactions rows from deleted load-test stations
 * stuck with isActive=true because every UPDATE (any column) raised
 * "No ChargingStation found with ocppConnectionName=stress031...".
 *
 * On UPDATE the station lookup is still attempted, but an unresolvable station
 * now leaves stationId NULL instead of aborting the write.
 */

const strictFunction = `
  CREATE OR REPLACE FUNCTION populate_station_id()
  RETURNS TRIGGER AS $$
  BEGIN
    SELECT "id" INTO NEW."stationId"
    FROM "ChargingStations"
    WHERE "ocppConnectionName" = NEW."ocppConnectionName" AND "tenantId" = NEW."tenantId";

    IF NEW."stationId" IS NULL THEN
      RAISE EXCEPTION 'No ChargingStation found with ocppConnectionName=% and tenantId=%',
                     NEW."ocppConnectionName", NEW."tenantId";
    END IF;

    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
`;

const relaxedFunction = `
  CREATE OR REPLACE FUNCTION populate_station_id()
  RETURNS TRIGGER AS $$
  BEGIN
    SELECT "id" INTO NEW."stationId"
    FROM "ChargingStations"
    WHERE "ocppConnectionName" = NEW."ocppConnectionName" AND "tenantId" = NEW."tenantId";

    IF NEW."stationId" IS NULL AND TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'No ChargingStation found with ocppConnectionName=% and tenantId=%',
                     NEW."ocppConnectionName", NEW."tenantId";
    END IF;

    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
`;

export = {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.sequelize.query(relaxedFunction);
    console.log('Migration 20260709000000-relax-station-id-trigger-on-update completed.');
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.sequelize.query(strictFunction);
  },
};
