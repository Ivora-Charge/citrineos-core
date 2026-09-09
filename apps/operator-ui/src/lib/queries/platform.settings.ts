// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { gql } from 'graphql-tag';

// PlatformSettings: platform-wide key/value configuration (core migration
// 20260908010000-create-platform-settings), edited on /settings/platform.

export const PLATFORM_SETTINGS_LIST_QUERY = gql`
  query PlatformSettingsList {
    PlatformSettings(order_by: { key: asc }) {
      key
      value
      updatedBy
      updatedAt
    }
  }
`;

export const PLATFORM_SETTINGS_UPSERT_MUTATION = gql`
  mutation PlatformSettingsUpsert($objects: [PlatformSettings_insert_input!]!) {
    insert_PlatformSettings(
      objects: $objects
      on_conflict: {
        constraint: PlatformSettings_pkey
        update_columns: [value, updatedBy, updatedAt]
      }
    ) {
      affected_rows
    }
  }
`;
