// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { gql } from 'graphql-tag';

// The business/payment columns are added by citrineos-core migration
// 20260624000000-add-tenant-business-payment-fields. The operator-ui onboarding
// wizard and /settings/business page read and write these via the Tenants table.

export const TENANT_GET_QUERY = gql`
  query GetTenantById($id: Int!) {
    Tenants_by_pk(id: $id) {
      id
      name
      url
      countryCode
      partyId
      stripeAccountId
      businessName
      businessAddress
      businessPostalCode
      businessCity
      businessState
      businessCountry
      businessContactEmail
      businessContactPhone
      defaultCurrency
      defaultPriceKwh
      defaultPriceMinute
      defaultPriceSession
      defaultAuthorizationAmount
      defaultTaxRate
      defaultPaymentFee
      paymentOnboardingCompletedAt
      createdAt
      updatedAt
    }
  }
`;

export const TENANTS_LIST_QUERY = gql`
  # offset/limit are nullable with defaults: the tenants page lists with
  # pagination mode 'off', so refine sends no pagination variables at all.
  query TenantsList(
    $offset: Int = 0
    $limit: Int = 500
    $order_by: [Tenants_order_by!]
    $where: Tenants_bool_exp
  ) {
    Tenants(offset: $offset, limit: $limit, order_by: $order_by, where: $where) {
      id
      name
      businessName
      businessCity
      businessCountry
      stripeAccountId
      paymentOnboardingCompletedAt
      createdAt
      updatedAt
    }
    Tenants_aggregate(where: $where) {
      aggregate {
        count
      }
    }
  }
`;

export const AUDIT_LOGS_LIST_QUERY = gql`
  query AuditLogsList($offset: Int!, $limit: Int!, $order_by: [AuditLogs_order_by!]) {
    AuditLogs(offset: $offset, limit: $limit, order_by: $order_by) {
      id
      actor
      actorRoles
      tenantId
      action
      target
      detail
      createdAt
    }
    AuditLogs_aggregate {
      aggregate {
        count
      }
    }
  }
`;

export const TENANT_CREATE_MUTATION = gql`
  mutation TenantCreate($object: Tenants_insert_input!) {
    insert_Tenants_one(object: $object) {
      id
      name
      createdAt
      updatedAt
    }
  }
`;

export const TENANT_EDIT_MUTATION = gql`
  mutation TenantEdit($id: Int!, $object: Tenants_set_input!) {
    update_Tenants_by_pk(pk_columns: { id: $id }, _set: $object) {
      id
      name
      url
      countryCode
      partyId
      stripeAccountId
      businessName
      businessAddress
      businessPostalCode
      businessCity
      businessState
      businessCountry
      businessContactEmail
      businessContactPhone
      defaultCurrency
      defaultPriceKwh
      defaultPriceMinute
      defaultPriceSession
      defaultAuthorizationAmount
      defaultTaxRate
      defaultPaymentFee
      paymentOnboardingCompletedAt
      createdAt
      updatedAt
    }
  }
`;
