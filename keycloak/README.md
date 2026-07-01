# Keycloak (ivora realm)

Identity provider for the operator UI (multi-tenant rollout Phase 1) and, in
Phase 2, the JWT authority for Hasura row-level permissions.

## Layout

- `ivora-realm.json` — declarative realm import, applied automatically on the
  container's **first** boot (`--import-realm`). Realm `ivora`, confidential
  client `citrineos-ui`, client roles, and two seeded users.
- `bootstrap.sh` — idempotent post-start fixup. Keycloak ≥24 ships with the
  declarative user profile enforced and *unmanaged* attributes disabled, which
  silently strips the `tenant_id` user attribute the UI reads from the token.
  The script flips the policy to ENABLED and re-asserts `tenant_id` on the
  seeded tenant user. Run it once after `docker compose up -d keycloak`.

## URLs

| What                       | URL                                                      |
|----------------------------|----------------------------------------------------------|
| Public (browser redirects) | `https://csms-test.ivoracharge.com/auth`                 |
| Container backchannel      | `http://keycloak:8180/auth` (compose network)            |
| Host                       | `http://localhost:8180/auth`                             |
| Admin console              | `https://csms-test.ivoracharge.com/auth/admin/` (`admin`) |

nginx proxies `/auth/` → `127.0.0.1:8180` (see
`setup-scripts/setup_nginx_csms_ssl.sh` in the parent repo). Keycloak runs with
a fixed `--hostname` so token issuers are always the public URL, even for
backchannel token calls from the UI container — this keeps NextAuth issuer
validation happy.

## Roles (client roles on `citrineos-ui`)

The UI reads roles from `resource_access.citrineos-ui.roles` and the tenant
from the top-level `tenant_id` claim (see
`apps/operator-ui/src/app/api/auth/[...nextauth]/options.ts`).

- `admin` / `user` — legacy roles the current access-control provider maps
  (`KeycloakRole.ADMIN/USER`). Every human user needs one of these until the
  provider learns the roles below (Phase 3).
- `platform-admin` — Ivora staff: all tenants, tenant CRUD, invites, claims.
- `platform-support` — Ivora staff: view all, OCPP commands, no billing.
- `tenant-admin` — property manager: own tenant's pricing/settings/claims.
- `tenant-viewer` — own tenant, read-only.

## Seeded users (test box — rotate before anything real)

| user            | password           | roles                   | tenant_id |
|-----------------|--------------------|-------------------------|-----------|
| `ivora-admin`   | `DaDCrNamAnj2AL7j` | admin, platform-admin   | —         |
| `tenant1-admin` | `19aEkb0NZsQHp8hb` | admin, tenant-admin     | 1         |

Keycloak admin (master realm): `admin` / `Zrx3Oa2mtXLFd8sbFOYh`.
Client secret `citrineos-ui`: `f21744f52399128c0358c4fe2f45dfb176494342adc1ed2e`
(also in `docker-compose.override.yml` as `KEYCLOAK_CLIENT_SECRET`).

## Verify token claims

```bash
curl -s http://localhost:8180/auth/realms/ivora/protocol/openid-connect/token \
  -d grant_type=password -d client_id=citrineos-ui \
  -d client_secret=f21744f52399128c0358c4fe2f45dfb176494342adc1ed2e \
  -d username=tenant1-admin -d password='19aEkb0NZsQHp8hb' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])' \
  | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool
```

Expect `resource_access.citrineos-ui.roles`, `tenant_id`, and
`iss: https://csms-test.ivoracharge.com/auth/realms/ivora`.

## Resetting

The realm imports only on first boot (H2 dev database on the `keycloak-data`
volume). To re-import from a changed `ivora-realm.json`:

```bash
docker compose down keycloak && docker volume rm citrineos-core_keycloak-data
docker compose up -d keycloak && ./keycloak/bootstrap.sh
```

`start-dev` + H2 is deliberate for the test box; move to `start` + Postgres
before production (Phase 8).
