# Multi-tenant browser smoke tests

Standalone Playwright scripts that exercise the multi-tenant surfaces against
a **running deployment** through the real Keycloak login flow. They are not
wired into the `tests/e2e` Playwright suite (which still uses the generic auth
provider); they run with nothing but node + playwright:

```bash
npm i playwright && npx playwright install chromium
node ui-test.js       # tenants page / audit / inventory as platform admin;
                      # business save + /tenants denial as tenant admin
node wizard-test.js   # full 6-step onboarding wizard as a fresh tenant admin
node fleet-test.js    # /fleet dashboard as platform admin + tenant rejection
```

Conventions and caveats:

- The base URL and the test users (`ivora-admin`, `tenant1-admin`,
  `wizard-admin@test.com`) are hardcoded at the top of each script — they
  match the csms-test box seeds in `keycloak/README.md`. Point them elsewhere
  by editing the constants.
- `wizard-test.js` needs a **not-yet-onboarded** tenant bound to its user
  (`paymentOnboardingCompletedAt` null), and completes that tenant's
  onboarding as a side effect — reset the flag to re-run.
- Keycloak walks first logins through profile completion when
  firstName/lastName are missing and forces temp-password changes; the
  scripts assume fully set-up users.
- Known console noise that the scripts filter out: missing help-video assets
  (404s) and a transient next-auth session fetch during the login redirect.

TODO(Phase 8 cutover): port these onto the `tests/e2e` fixtures once the e2e
auth setup project speaks Keycloak.
