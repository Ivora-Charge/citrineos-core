/* Browser verification of the multi-tenant operator-ui (Phases 1-5).
 * Logs in through the real Keycloak flow as both a platform admin and a
 * tenant admin, exercises the new surfaces, and reports console errors,
 * failed GraphQL calls, and screenshots. */
const { chromium } = require('playwright');

const BASE = 'https://csms-test.ivoracharge.com';
const USERS = {
  platform: { user: 'ivora-admin', pass: 'DaDCrNamAnj2AL7j' },
  tenant: { user: 'tenant1-admin', pass: '19aEkb0NZsQHp8hb' },
};

async function login(page, who) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  // KeycloakLoginPage auto-redirects via signIn(); wait for the KC form.
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', USERS[who].user);
  await page.fill('#password', USERS[who].pass);
  await page.click('#kc-login');
  await page.waitForURL(`${BASE}/**`, { timeout: 30000 });
  await page.waitForLoadState('networkidle');
}

async function run(who, steps) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`[console.error] ${msg.text().slice(0, 300)}`);
  });
  page.on('response', async (res) => {
    if (res.url().includes('/graphql') && res.ok()) {
      try {
        const body = await res.json();
        if (body.errors) problems.push(`[graphql] ${JSON.stringify(body.errors[0]).slice(0, 300)}`);
      } catch {}
    }
    if (!res.ok() && res.status() >= 400 && !res.url().includes('favicon')) {
      problems.push(`[http ${res.status()}] ${res.url().slice(0, 160)}`);
    }
  });

  console.log(`\n===== ${who} =====`);
  try {
    await login(page, who);
    console.log(`login OK -> ${page.url()}`);
    await steps(page);
  } catch (e) {
    problems.push(`[fatal] ${e.message.slice(0, 400)}`);
  }
  if (problems.length) {
    console.log(`PROBLEMS (${problems.length}):`);
    for (const p of [...new Set(problems)]) console.log('  ' + p);
  } else {
    console.log('no console/graphql/http errors');
  }
  await browser.close();
}

(async () => {
  await run('platform', async (page) => {
    // Tenants page: table + inventory + audit
    await page.goto(`${BASE}/tenants`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: 'tenants-platform.png', fullPage: true });
    const rows = await page.locator('table >> nth=0 >> tbody tr').count();
    console.log(`tenants table rows: ${rows}`);
    const hasInventory = await page.getByText('Charger inventory').count();
    const hasAudit = await page.getByText('Audit log').count();
    console.log(`inventory card: ${hasInventory > 0}, audit card: ${hasAudit > 0}`);
    // Tenant detail of Big Ma Enterprise if present
    const bigMa = page.locator('td', { hasText: 'Big Ma Enterprise' }).first();
    if (await bigMa.count()) {
      await bigMa.click();
      await page.waitForLoadState('networkidle');
      console.log(`tenant detail url: ${page.url()}`);
      await page.screenshot({ path: 'tenant-detail.png', fullPage: true });
      const usersHdr = await page.getByText('Users', { exact: true }).count();
      console.log(`users section present: ${usersHdr > 0}`);
    }
    // Charging stations list renders for platform user
    await page.goto(`${BASE}/charging-stations`, { waitUntil: 'networkidle' });
    const claimBtn = await page.getByText('Claim charger').count();
    console.log(`claim button on stations list: ${claimBtn > 0}`);
  });

  await run('tenant', async (page) => {
    // Business settings save round-trip
    await page.goto(`${BASE}/settings/business`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: 'business-tenant.png', fullPage: true });
    const city = page.locator('input[name="businessCity"]');
    if (await city.count()) {
      await city.fill('Clickton');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      const toast = await page
        .getByText('Business settings saved.', { exact: false })
        .first()
        .waitFor({ timeout: 10000 })
        .then(() => true)
        .catch(() => false);
      console.log(`business save toast: ${toast}`);
    } else {
      console.log('businessCity input not found');
    }
    // Stripe connect status line should render
    const stripeLine = await page.getByText(/Stripe account|No Stripe account|Onboarding/).count();
    console.log(`stripe status visible: ${stripeLine > 0}`);
    // /tenants must be denied
    await page.goto(`${BASE}/tenants`, { waitUntil: 'networkidle' });
    const denied = await page.getByText(/denied|not.*access|Access/i).count();
    const table = await page.locator('tbody tr').count();
    console.log(`tenants page denied for tenant user: denied-text=${denied > 0}, table-rows=${table}`);
    await page.screenshot({ path: 'tenants-tenantuser.png', fullPage: true });
  });
})();
