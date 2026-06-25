<!--
SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project

SPDX-License-Identifier: Apache-2.0
-->

![CitrineOS Logo](public/logo_white.png#gh-dark-mode-only)
![CitrineOS Logo](public/logo_black.png#gh-light-mode-only)

<div align="center">
  <img
    src="public/OCPP_201_Logo_core_and_advanced_security.png"
    alt="CitrineOS Certification Logo"
    width="200"
    height="100"
  />
</div>

# Welcome to CitrineOS Operator UI

**CitrineOS Operator UI** is the web-based operator interface for **CitrineOS**, an open-source, modular backend
platform for managing Electric Vehicle (EV) charging infrastructure.

This repository contains the **Operator-facing User Interface** and related tooling.  
It is designed to work together with **CitrineOS Core**, which provides the charging station management logic,
OCPP message handling, persistence layer, and GraphQL APIs.

> ⚠️ **Important:**  
> The Operator UI **does not run standalone**.  
> A running instance of **CitrineOS Core** (including Hasura GraphQL Engine) is required.

This app is one workspace member of the `citrineos-core` pnpm monorepo. For repository-wide setup and for running the
full stack (server + UI + Hasura) together, see the [root README](../../README.md).

---

## Table of Contents

- [Overview](#overview)
- [Architecture & Data Flow](#architecture--data-flow)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
  - [Running with Docker](#running-with-docker-recommended)
  - [Running with pnpm (Local Development)](#running-with-pnpm-local-development)
- [Working with `@citrineos/base`](#working-with-citrineosbase)
- [Build & Development Workflow](#build--development-workflow)
- [Running the Application](#running-the-application)
- [Bringing a Charging Station Online (End-to-End)](#bringing-a-charging-station-online-end-to-end)
  - [Create a Location](#create-a-location)
  - [Add a Charging Station (Charge Point)](#add-a-charging-station-charge-point)
  - [Add an EVSE (Electric Vehicle Supply Equipment)](#add-an-evse-electric-vehicle-supply-equipment)
  - [Add a Connector](#add-a-connector)
  - [Add an Authorization (ID Token)](#add-an-authorization-id-token)
  - [Start the Charging Station (EVerest)](#start-the-charging-station-everest)
- [Usage](#usage)
- [Hasura Authentication](#hasura-authentication)
- [Related Documentation](#related-documentation)
- [Contributing](#contributing)
- [Licensing](#licensing)
- [Support & Contact](#support--contact)

---

## Overview

The CitrineOS Operator UI provides operators with:

- Visibility into charging stations, connectors, sessions, and transactions
- Operational controls via CitrineOS Core Message APIs
- Data access through **Hasura GraphQL Engine**
- A modern React-based UI built with **Refine**

The UI consumes:

- **Hasura GraphQL APIs** for data access
- **CitrineOS Core Message APIs** for sending commands to charging stations
- **CitrineOS Core Data APIs** for managing entities

---

## Architecture & Data Flow

```text
+-------------------+       GraphQL       +----------------------+
|                   |  <----------------> |                      |
|  Operator UI      |                     |  Hasura GraphQL      |
|                   |                     |  Engine              |
|                   |                     |                      |
+-------------------+                     +----------+-----------+
                                                       |
                                                       | SQL
                                                       |
                                             +---------v-----------+
                                             |                     |
                                             |  PostgreSQL         |
                                             |                     |
                                             +---------------------+

+-------------------+       REST       +--------------------------+
| Operator UI       | <--------------> | CitrineOS Core           |
|                   |                  | (OCPP 1.6 & 2.0.1)       |
+-------------------+                  +--------------------------+
```

## Prerequisites

Before starting, ensure the following tools and services are installed and running.

- **Node.js** (v24.16.0 or higher)  
  [Link](https://nodejs.org)

- **pnpm**  
  [Link](https://pnpm.io/installation) — the workspace's package manager

- **Docker & Docker Compose** (recommended)  
  [Link](https://www.docker.com/products/docker-desktop/)

The following services must be available before starting the application:

- **CitrineOS Core**  
  Backend service responsible for OCPP 1.6 and OCPP 2.0.1 handling, charging station management, and APIs.

- **Hasura GraphQL Engine**  
  GraphQL layer used for data access and management.

References:

- **CitrineOS Core Repository**  
  [Documentation](https://github.com/citrineos/citrineos-core)

- **Hasura Documentation**  
  [Documentation](https://hasura.io/docs/2.0/)

## Getting Started

### Running with Docker (Recommended)

If **CitrineOS Core** is already running via Docker, the Operator UI can be started with a single command:

```bash
docker compose up -d
```

This will:

- Build the Operator UI container
- Start the UI connected to the configured Hasura and Core service

### Running with pnpm (Local Development)

The Operator UI lives inside the `citrineos-core` **pnpm workspace** (under `apps/operator-ui`). Install all
workspace dependencies once from the repository root, then start the dev server:

```bash
# from the repository root
pnpm install

# then, from apps/operator-ui
pnpm run dev
```

This starts the development server (Next.js + Refine) with hot reload.

### Working with `@citrineos/base`

The Operator UI depends on `@citrineos/base` via a `workspace:*` dependency, so pnpm resolves it from the local
`packages/base` automatically — no `npm link` step is required. Just build the workspace packages so the compiled
output is available:

```bash
# from the repository root
pnpm run build
```

## Build & Development Workflow

The Operator UI is a member of the `citrineos-core` **pnpm workspace**.

### Typical Workflow

1. Install and build the workspace from the repository root:

```bash
# from the repository root
pnpm install
pnpm run build
```

2. Start the dev server:

```bash
# from apps/operator-ui
pnpm run dev
```

## Running the Application

### Development Mode

```bash
pnpm run dev
```

- Runs the app with hot reload
- Default URL: http://localhost:3000

### Production Build

```bash
pnpm run build
pnpm run start
```

- Production URL: http://localhost:3000

## Bringing a Charging Station Online (End-to-End)

This section describes the **minimum operational steps** required to bring a charging station online using:

- **CitrineOS Operator UI**
- **CitrineOS Core**
- **EVerest simulator**

These steps are required even for local development and testing.

---

### Create a Location

In CitrineOS, **all charging stations must belong to a Location**.

1. Open **CitrineOS Operator UI**:
2. Navigate to:

```pgsql
Locations → Create Location
```

3. Fill in the required metadata (name, address, country, etc.)
4. Save the Location

> A Location represents a physical site such as a parking garage, depot, or charging hub.

---

### Add a Charging Station (Charge Point)

To add a new charging station in CitrineOS Operator UI:

1. Navigate to:

```sql
Charging Stations → Add Charging Station
```

2. Select the previously created **Location**.

3. Use the default **Charge Point ID**:

```nginx
cp001
```

> ⚠️ **Important:**
> The Charge Point ID must exactly match the ID used by your physical charging station or simulator.
> By default, **EVerest** uses `cp001`.

4. Click **Save** to create the charging station.

---

### Add an EVSE (Electric Vehicle Supply Equipment)

Each Charging Station must contain at least one EVSE.

1. Open the Charging Station you just created.
2. Navigate to:

```sql
EVSEs → Add EVSE
```

3. Use a numeric **EVSE ID** (example: `1`).
4. Click **Save**.

> EVSEs represent physical charge points within a station (e.g., left/right ports).

---

### Add a Connector

Each EVSE must have at least one Connector.

1. Open the EVSE.
2. Navigate to:

```sql
Connectors → Add Connector
```

3. Choose:
   - **Connector ID** (example: `1`)
   - **Connector type** (Type2, CCS, etc.)
4. Click **Save**.

> Without a Connector, charging sessions cannot be started.

---

### Add an Authorization (ID Token)

To allow charging sessions, an ID Token must be authorized.

1. Navigate to:

```sql
Authorizations → Add Authorization
```

2. Create an **ID Token** (RFID, app token, etc.)
3. Mark it as **Accepted**
4. Click **Save**

> ⚠️ Note: This token will be used by EVerest to start charging.
> The EVerest simulator uses the **default RFID token** `DEADBEEF` **(ISO14443)**.

---

### Start the Charging Station (EVerest)

Now that the backend configuration is complete, start the EVerest simulator:

```bash
cd citrineos-core/apps/Server
pnpm run start-everest
```

This will:
**In Operator UI**

- Navigate to **Charging Stations**
- Status should show:

```nginx
Online
```

You can now track OCPP logs for the charging station.

## Usage

Once running, the Operator UI allows you to:

- View and manage charging stations and connectors
- Monitor transactions and sessions
- Trigger charging station commands (via CitrineOS Core)
- Query and manage data through Hasura-backed GraphQL APIs

## Hasura Authentication

There are two ways to authenticate to Hasura:

1. If you have \*_uncommented_ the Docker environment variable `HASURA_GRAPHQL_ADMIN_SECRET` in `citrineos-core`: 2. Ensure your `.env.local` has the `HASURA_ADMIN_SECRET` uncommented out 3. Please note that it is not recommended to use a Hasura Admin Secret in production.
2. If you have commented the Docker environment variable `HASURA_GRAPHQL_ADMIN_SECRET` in `citrineos-core`: 5. Ensure your `.env.local` has the `HASURA_ADMIN_SECRET` commented out, as the auth will be handled by your auth provider automatically.

## Payments Onboarding

The operator-ui includes a tenant onboarding wizard (`/onboarding`) and a
business settings page (`/settings/business`) that capture the tenant's business
details, Stripe Connect account, and default pricing, then push the
`payment_*` catalog to the [`citrineos-payment`](../../../citrineos-payment)
service so operators no longer run `seed.py` by hand.

- The main nav is **gated** until onboarding completes: a tenant whose
  `paymentOnboardingCompletedAt` is unset is redirected to `/onboarding`. That
  column (and the business/Stripe columns) is added by the core migration
  `20260624000000-add-tenant-business-payment-fields`.
- On **Complete** (and via **Sync payments** on the settings page) the UI calls
  the `syncPaymentCatalog` server action, which POSTs one entry per EVSE to the
  payment service's `POST /api/catalog/sync`. The EVSE business key convention is
  `{ocppConnectionName}-{evseId}`.

Add to `.env.local` (the secret is read **server-side only** and must never be
exposed to the browser):

```bash
# Base URL of the citrineos-payment service
NEXT_PUBLIC_PAYMENT_SERVICE_URL="http://localhost:9010"
# Must match PAYMENT_CATALOG_SYNC_SECRET in citrineos-payment/.env
PAYMENT_CATALOG_SYNC_SECRET="changeme-dev-secret"
```

For local dev without Stripe Connect, enter `platform` as the Stripe account id
to charge on the platform account.

## Related Documentation

- **CitrineOS Core**
  - [Docs](https://github.com/citrineos/citrineos-core)
- **CitrineOS Project Docs**
  - [Docs](https://citrineos.github.io)
- **Refine**
  - [Docs](https://refine.dev/docs)
- **Hasura GraphQL Engine**
  - [Docs](https://hasura.io/docs/2.0/index/)
- **Postgres Data Connector**
  - [Docs](https://hasura.io/docs/2.0/databases/postgres/index/)

## Contributing

We welcome contributions from the community. If you would like to contribute to CitrineOS, please follow
our [contribution guidelines](https://github.com/citrineos/citrineos/blob/main/CONTRIBUTING.md).

## Licensing

CitrineOS and its subprojects are licensed under the Apache License, Version 2.0.

## Support and Contact

If you need help or want to report an issue:

- Open an issue on GitHub
- Reach out via the CitrineOS community channels
