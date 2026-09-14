#!/usr/bin/env python3
"""Derive the multi-tenant permission roles in the Hasura metadata directory
(rollout Phase 2).

Upstream CitrineOS metadata already defines a tenant-scoped ``user`` role
(``tenantId = x-hasura-tenant-id`` filters on every table; the Tenants table
restricted to the caller's own row). This script derives the rollout's roles
from that single source of truth instead of hand-writing 50+ permission
blocks:

  tenant-admin      CRUD derived from ``user``, with tenant-owned parent checks
  tenant-viewer     tenant-scoped reads, excluding raw OCPP logs and credentials
  platform-support  existing permissions preserved; regular access does not revoke support
  (platform-admin uses Hasura's built-in ``admin`` role via the JWT's
   allowed-roles -- no metadata entry needed or possible)

The graphql-engine container runs the ``cli-migrations-v3`` image with
``apps/ocpp-server/hasura-metadata`` mounted, and RE-APPLIES that directory on
every start -- so the YAML directory, not the live instance, is the durable
source of truth. This script rewrites the per-table YAMLs in place (git
tracks the result) and can also push the change to the running instance with
``--apply``.

Idempotent: derived roles are rebuilt from the current ``user`` permissions
on each run.

Usage:
  ./apply-tenancy-permissions.py --dry-run          # print planned changes
  ./apply-tenancy-permissions.py                    # rewrite the YAMLs
  ./apply-tenancy-permissions.py --apply [--url http://localhost:8090] \
        [--admin-secret S]                          # ...and reload the live instance
"""

import argparse
import copy
import json
import sys
import urllib.request
from pathlib import Path

import yaml

DERIVED_ROLES = ("tenant-admin", "tenant-viewer")
PERM_KINDS = (
    "select_permissions",
    "insert_permissions",
    "update_permissions",
    "delete_permissions",
)
DEFAULT_METADATA_DIR = (
    Path(__file__).resolve().parent.parent / "apps" / "ocpp-server" / "hasura-metadata"
)

# These fields describe the shared listener, including mappings to other tenants
# and private-key storage locations. Tenant operators only need connection data.
NETWORK_PROFILE_TENANT_COLUMNS = [
    "id", "host", "port", "pingInterval", "protocols", "messageTimeout",
    "securityProfile", "allowUnknownChargingStations", "dynamicTenantResolution",
    "tenantId", "createdAt", "updatedAt",
]

# These values are proof of completed payment onboarding, not editable business
# details. Only the authenticated server-side onboarding flow may set them.
TENANT_SERVER_MANAGED_COLUMNS = {"stripeAccountId", "paymentOnboardingCompletedAt"}

# These tables hold unredacted protocol payloads / copies of variable values.
# Restricting the VariableAttributes root alone does not restrict these roots.
VIEWER_PRIVATE_TABLES = {"OCPPMessages", "VariableStatuses", "EventData"}


def credential_name_filter(column: str) -> dict:
    """Known protocol credential names, also covering vendor password/secret keys."""
    return {"_or": [
        {column: {"_ilike": "%password%"}},
        {column: {"_ilike": "%passwd%"}},
        {column: {"_ilike": "%secret%"}},
        {column: {"_ilike": "%authorization%key%"}},
        {column: {"_ilike": "%private%key%"}},
        {column: {"_ilike": "%api%key%"}},
        {column: {"_ilike": "%token%"}},
        {column: {"_ilike": "%credential%"}},
    ]}


def viewer_select(select: dict, table_name: str) -> dict | None:
    # Raw request/response payloads can contain SetVariables passwords or
    # ChangeConfiguration authorization keys. No payload-redacted view exists.
    if table_name in VIEWER_PRIVATE_TABLES:
        return None
    permission = copy.deepcopy(select)
    if table_name == "VariableAttributes":
        permission["filter"] = {"_and": [
            permission.get("filter", {}),
            {"_or": [{"dataType": {"_is_null": True}}, {"dataType": {"_neq": "passwordString"}}]},
            {"_not": {"Variable": credential_name_filter("name")}},
            {"_not": {"Variable": {"VariableCharacteristic": {
                "dataType": {"_eq": "passwordString"},
            }}}},
        ]}
    elif table_name == "ChangeConfigurations":
        permission["filter"] = {"_and": [
            permission.get("filter", {}), {"_not": credential_name_filter("key")},
        ]}
    return permission


def relationship_checks(table: dict) -> list[dict]:
    """A tenant-owned child may only reference parents in the same tenant.

    Foreign-key existence alone does not enforce tenancy, and Hasura's select
    filter on the parent does not constrain insert/update foreign-key values.
    Only local single-column FK relationships are used here; reverse relations
    describe a different row and cannot constrain this row's ownership.
    """
    checks = []
    for relationship in table.get("object_relationships", []):
        column = relationship.get("using", {}).get("foreign_key_constraint_on")
        if not isinstance(column, str) or column == "tenantId":
            continue
        checks.append({"_or": [
            {column: {"_is_null": True}},
            {relationship["name"]: {"tenantId": {"_eq": "x-hasura-tenant-id"}}},
        ]})
    return checks


def enforce_relationship_checks(table: dict, changes: list, table_name: str) -> None:
    constraints = relationship_checks(table)
    if not constraints:
        return
    for kind in ("insert_permissions", "update_permissions"):
        for entry in table.get(kind, []):
            if entry["role"] not in ("user", "tenant-admin"):
                continue
            current = entry["permission"].get("check", {})
            terms = (copy.deepcopy(current["_and"])
                     if set(current) == {"_and"} else [copy.deepcopy(current)])
            missing = [constraint for constraint in constraints if constraint not in terms]
            if missing:
                entry["permission"]["check"] = {"_and": terms + missing}
                changes.append(f"{table_name}: {entry['role']} {kind} parent ownership")


def derive(table: dict, changes: list, table_name: str) -> None:
    if table_name == "ServerNetworkProfiles":
        for entry in table.get("select_permissions", []):
            if entry["role"] in ("user", "tenant-admin", "tenant-viewer"):
                if entry["permission"].get("columns") != NETWORK_PROFILE_TENANT_COLUMNS:
                    entry["permission"]["columns"] = NETWORK_PROFILE_TENANT_COLUMNS.copy()
                    changes.append(f"{table_name}: limit {entry['role']} connection columns")

    if table_name == "Tenants":
        for entry in table.get("update_permissions", []):
            if entry["role"] in ("user", "tenant-admin"):
                columns = entry["permission"].get("columns", [])
                if columns == "*":
                    raise ValueError("Tenants update requires an explicit safe column list")
                allowed = [column for column in columns
                           if column not in TENANT_SERVER_MANAGED_COLUMNS]
                if allowed != columns:
                    entry["permission"]["columns"] = allowed
                    changes.append(f"{table_name}: protect {entry['role']} payment onboarding")

    enforce_relationship_checks(table, changes, table_name)

    user_perms = {
        kind: next((p for p in table.get(kind, []) if p["role"] == "user"), None)
        for kind in PERM_KINDS
    }
    if not any(user_perms.values()):
        return

    for kind in PERM_KINDS:
        if kind in table:
            table[kind] = [p for p in table[kind] if p["role"] not in DERIVED_ROLES]
            if not table[kind]:
                del table[kind]

    def add(kind, role, permission):
        table.setdefault(kind, []).append({"role": role, "permission": permission})
        changes.append(f"{table_name}: {kind} += {role}")

    for kind in PERM_KINDS:
        if user_perms[kind]:
            add(kind, "tenant-admin", copy.deepcopy(user_perms[kind]["permission"]))

    if user_perms["select_permissions"]:
        select = user_perms["select_permissions"]["permission"]
        viewer = viewer_select(select, table_name)
        if viewer is not None:
            add("select_permissions", "tenant-viewer", viewer)


def reload_live(url: str, secret: str) -> None:
    req = urllib.request.Request(
        f"{url}/v1/metadata",
        data=json.dumps({"type": "reload_metadata", "args": {}}).encode(),
        headers={
            "Content-Type": "application/json",
            **({"x-hasura-admin-secret": secret} if secret else {}),
        },
    )
    with urllib.request.urlopen(req) as res:
        json.load(res)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--metadata-dir", type=Path, default=DEFAULT_METADATA_DIR)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--apply", action="store_true", help="also reload the running instance")
    ap.add_argument("--url", default="http://localhost:8090")
    ap.add_argument("--admin-secret", default="")
    args = ap.parse_args()

    tables_dir = args.metadata_dir / "databases" / "default" / "tables"
    if not tables_dir.is_dir():
        print(f"metadata tables dir not found: {tables_dir}", file=sys.stderr)
        return 1

    changes: list[str] = []
    for path in sorted(tables_dir.glob("public_*.yaml")):
        text = path.read_text()
        # keep the SPDX header comment lines yaml.safe_load would drop
        header = "".join(
            line for line in text.splitlines(keepends=True) if line.startswith("#")
        )
        table = yaml.safe_load(text)
        before = len(changes)
        derive(table, changes, table["table"]["name"])
        if len(changes) == before:
            continue
        if not args.dry_run:
            path.write_text(
                header + yaml.safe_dump(table, sort_keys=False, default_flow_style=False)
            )

    if args.dry_run:
        print("\n".join(changes))
        print(f"-- {len(changes)} permission blocks (dry run, nothing written)")
        return 0

    print(f"wrote {len(changes)} permission blocks into {tables_dir}")
    if args.apply:
        # The mounted dir only re-applies on container start; for a running
        # instance we push the same state through the metadata API. Simplest
        # correct route: restart the container. reload_metadata alone does NOT
        # re-read the mounted dir, so recommend restart instead.
        print("note: restart the graphql-engine container to load the new YAMLs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
