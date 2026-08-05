#!/usr/bin/env bash
# Post-start bootstrap for the ivora Keycloak realm.
#
# The realm itself is created declaratively by --import-realm from
# ivora-realm.json (first boot only). This script covers the one thing realm
# import cannot express reliably: since Keycloak 24 the declarative user
# profile is always on and its default "unmanaged attribute" policy is
# DISABLED, which silently strips custom user attributes -- including the
# tenant_id attribute the operator-ui reads from the token. We flip the policy
# to ENABLED and re-assert tenant_id on the seeded tenant user.
#
# Idempotent; run it any time after `docker compose up -d keycloak`:
#   ./keycloak/bootstrap.sh
#
# Env overrides: KC_CONTAINER, KC_URL, KC_ADMIN_USER, KC_ADMIN_PASSWORD
set -euo pipefail

KC_CONTAINER="${KC_CONTAINER:-citrineos-core-keycloak-1}"
KC_URL="${KC_URL:-http://localhost:8180/auth}"
KC_ADMIN_USER="${KC_ADMIN_USER:-admin}"
KC_ADMIN_PASSWORD="${KC_ADMIN_PASSWORD:-Zrx3Oa2mtXLFd8sbFOYh}"
REALM="ivora"

kcadm() {
  docker exec "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"
}

echo "==> waiting for Keycloak at $KC_URL"
for i in $(seq 1 60); do
  if docker exec "$KC_CONTAINER" bash -c "exec 3<>/dev/tcp/localhost/8180" 2>/dev/null; then
    break
  fi
  sleep 2
done

echo "==> logging in to the admin API"
kcadm config credentials --server "$KC_URL" --realm master \
  --user "$KC_ADMIN_USER" --password "$KC_ADMIN_PASSWORD"

echo "==> allowing unmanaged user attributes (tenant_id) in realm $REALM"
kcadm update "realms/$REALM/users/profile" \
  -s 'unmanagedAttributePolicy=ENABLED'

echo "==> asserting the ivora login theme (adds the /signup link)"
kcadm update "realms/$REALM" -s 'loginTheme=ivora'

echo "==> re-asserting tenant_id=1 on tenant1-admin (import may have stripped it)"
USER_ID=$(kcadm get "users" -r "$REALM" -q username=tenant1-admin --fields id --format csv --noquotes | head -1)
if [ -n "$USER_ID" ]; then
  kcadm update "users/$USER_ID" -r "$REALM" -s 'attributes.tenant_id=["1"]'
  echo "    tenant1-admin ($USER_ID) updated"
else
  echo "    tenant1-admin not found -- was the realm imported?" >&2
  exit 1
fi

echo "==> done. Verify a token carries the claims with:"
echo "    curl -s $KC_URL/realms/$REALM/protocol/openid-connect/token \\"
echo "      -d grant_type=password -d client_id=citrineos-ui \\"
echo "      -d client_secret=<secret> -d username=tenant1-admin -d password=<pw>"
