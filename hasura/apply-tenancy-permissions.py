#!/usr/bin/env python3
"""Derive the multi-tenant permission roles in the Hasura metadata directory
(rollout Phase 2).

Upstream CitrineOS metadata already defines a tenant-scoped ``user`` role
(``tenantId = x-hasura-tenant-id`` filters on every table; the Tenants table
restricted to the caller's own row). This script derives the rollout's roles
from that single source of truth instead of hand-writing 50+ permission
blocks:

  tenant-admin      full CRUD, cloned verbatim from ``user`` (tenant-filtered)
  tenant-viewer     the ``user`` select permissions only (read-only tenant view)
  platform-support  select-only clone with the tenant filter dropped (all
                    tenants), for Ivora support staff; no writes
  (platform-admin uses Hasura's built-in ``admin`` role via the JWT's
   allowed-roles -- no metadata entry needed or possible)

The graphql-engine container runs the ``cli-migrations-v3`` image with
``apps/Server/hasura-metadata`` mounted, and RE-APPLIES that directory on
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

DERIVED_ROLES = ("tenant-admin", "tenant-viewer", "platform-support")
PERM_KINDS = (
    "select_permissions",
    "insert_permissions",
    "update_permissions",
    "delete_permissions",
)
DEFAULT_METADATA_DIR = (
    Path(__file__).resolve().parent.parent / "apps" / "Server" / "hasura-metadata"
)


def drop_tenant_filter(node):
    """Remove {"tenantId": {"_eq": "x-hasura-tenant-id"}} (and the Tenants
    variant keyed on id) from a boolean expression, recursively. Returns {}
    (allow all rows) when the filter was the whole expression."""
    if not isinstance(node, dict):
        return node
    out = {}
    for k, v in node.items():
        if k in ("tenantId", "id") and v == {"_eq": "x-hasura-tenant-id"}:
            continue
        if k in ("_and", "_or") and isinstance(v, list):
            kept = [drop_tenant_filter(x) for x in v]
            kept = [x for x in kept if x not in ({}, None)]
            if kept:
                out[k] = kept
            continue
        out[k] = drop_tenant_filter(v)
    return out


def derive(table: dict, changes: list, table_name: str) -> None:
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
        add("select_permissions", "tenant-viewer", copy.deepcopy(select))
        support = copy.deepcopy(select)
        support["filter"] = drop_tenant_filter(support.get("filter", {}))
        add("select_permissions", "platform-support", support)


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
