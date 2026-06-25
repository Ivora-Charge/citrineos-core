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
      paymentOnboardingCompletedAt
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
      paymentOnboardingCompletedAt
      createdAt
      updatedAt
    }
  }
`;
