/* Full onboarding wizard run as a brand-new tenant admin (tenant 7). */
const { chromium } = require('playwright');
const BASE = 'https://csms-test.ivoracharge.com';
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text().slice(0, 250)));
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message.slice(0, 250)));

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#username');
  await page.fill('#username', 'wizard-admin@test.com');
  await page.fill('#password', 'WizardTest1!');
  await page.click('#kc-login');
  await page.waitForURL(`${BASE}/**`, { timeout: 30000 });
  // Fresh tenant -> should be redirected into onboarding
  await page.waitForURL('**/onboarding', { timeout: 20000 });
  console.log('redirected to wizard:', page.url());
  await page.waitForLoadState('networkidle');
  // Dismiss the first-login help modal that overlays the page.
  const closeBtn = page.getByRole('button', { name: 'Close', exact: true });
  if (await closeBtn.count()) {
    await closeBtn.click();
    console.log('closed first-login modal');
  }

  // Step 0: tenant profile
  await page.fill('input[name="name"]', 'Wizard Test Tenant');
  await page.getByRole('button', { name: /Next/ }).click();
  // Step 1: business
  await page.fill('input[name="businessName"]', 'Wizard Test LLC');
  await page.fill('input[name="businessAddress"]', '7 Wizard Way');
  await page.fill('input[name="businessCity"]', 'Springfield');
  await page.getByRole('button', { name: /Next/ }).click();
  // Step 2: Stripe -- verify the Connect button + status render; use the
  // manual escape hatch so the automated test doesn't leave the site.
  await page.waitForSelector('text=Connect with Stripe');
  console.log('stripe step: Connect button visible');
  await page.fill('input[name="stripeAccountId"]', 'platform');
  await page.getByRole('button', { name: /Next/ }).click();
  // Step 3: claim -- claim cptest? It belongs to tenant 1; move a station to
  // inventory first would disturb live data, so just verify the input renders.
  await page.waitForSelector('input[placeholder*="Serial number"]');
  console.log('claim step: serial input visible');
  await page.getByRole('button', { name: /Next/ }).click();
  // Step 4: default tariff
  await page.fill('input[name="currency"]', 'usd');
  await page.fill('input[name="priceKwh"]', '0.42');
  await page.fill('input[name="authorizationAmount"]', '30');
  await page.getByRole('button', { name: /Next/ }).click();
  // Step 5: review + complete
  await page.waitForSelector('text=Review & complete');
  await page.screenshot({ path: 'wizard-review.png', fullPage: true });
  await page.getByRole('button', { name: /Complete/ }).click();
  await page.waitForURL('**/overview', { timeout: 30000 }).catch(() => {});
  console.log('after complete:', page.url());
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'wizard-done.png', fullPage: true });

  if (problems.length) {
    console.log('PROBLEMS:');
    for (const p of [...new Set(problems)]) console.log('  ' + p);
  } else console.log('no console errors');
  await browser.close();
})();
