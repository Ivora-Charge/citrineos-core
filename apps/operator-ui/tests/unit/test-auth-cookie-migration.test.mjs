import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTestEnvironment } from '../../src/lib/utils/environment-safety.ts';
import { authCookieOptionsForHost } from '../../src/lib/utils/auth-cookie.ts';
import { hasDuplicateTestSessionCookies, hasTestLogoutMarker, migrateTestAuthCookies, writeTestLogoutMarker } from '../../src/lib/utils/test-auth-cookie-migration.ts';

const url = 'https://qvytgefpcomloxlvuwur.supabase.co';
const key = 'sb-qvytgefpcomloxlvuwur-auth-token';
const productionKey = 'sb-uoatfgdxafvetninytuu-auth-token';
const domain = '.ivoracharge.com';

function session(user, issuer = `${url}/auth/v1`) {
  const payload = Buffer.from(JSON.stringify({ iss: issuer, sub: user })).toString('base64url');
  return 'base64-' + Buffer.from(JSON.stringify({ access_token: `header.${payload}.signature`, refresh_token: `refresh-${user}` })).toString('base64url');
}

function cookieJar(entries = []) {
  return {
    entries: entries.map(([name, value, scope = null]) => ({ name, value, scope })),
    get cookie() { return this.entries.map(({ name, value }) => `${name}=${value}`).join('; '); },
    set cookie(assignment) {
      const [pair, ...attributes] = assignment.split(';').map((part) => part.trim());
      const index = pair.indexOf('=');
      const name = pair.slice(0, index), value = pair.slice(index + 1);
      const scope = attributes.find((part) => part.startsWith('Domain='))?.slice(7) ?? null;
      this.entries = this.entries.filter((cookie) => cookie.name !== name || cookie.scope !== scope);
      if (!attributes.includes('Max-Age=0')) this.entries.push({ name, value, scope });
    },
  };
}

function migrate(cookies, overrides = {}) {
  return migrateTestAuthCookies({ environment: 'test', supabaseUrl: url, cookieDomain: domain,
    hostname: 'csms-test.ivoracharge.com', protocol: 'https:', cookies, ...overrides });
}

test('test guard permits deliberate shared domain and localhost host-only; blocks production and other scopes', () => {
  assert.doesNotThrow(() => assertTestEnvironment('test', url, domain));
  assert.doesNotThrow(() => assertTestEnvironment('test', 'http://localhost:54321', ''));
  assert.throws(() => assertTestEnvironment('test', 'https://uoatfgdxafvetninytuu.supabase.co', domain), /production/);
  assert.throws(() => assertTestEnvironment('test', url, '.example.com'), /cookie domain/);
  assert.throws(() => assertTestEnvironment('test', 'http://localhost:54321', domain), /hosted/);
  assert.throws(() => assertTestEnvironment('test', `${url}/other`, domain), /origin/);
});

test('promotes host-only session without touching production cookies; second run is inert', () => {
  const old = session('local');
  const jar = cookieJar([[key, old], [productionKey, 'production', domain]]);
  assert.equal(migrate(jar), true);
  assert.deepEqual(jar.entries, [
    { name: productionKey, value: 'production', scope: domain },
    { name: key, value: old, scope: domain },
  ]);
  assert.equal(migrate(jar), false);
});

test('shared login wins duplicate names in either browser cookie ordering', () => {
  for (const entries of [
    [[key, session('host')], [key, session('shared'), domain]],
    [[key, session('shared'), domain], [key, session('host')]],
  ]) {
    const jar = cookieJar(entries);
    assert.equal(hasDuplicateTestSessionCookies(jar.cookie, url), true);
    assert.equal(migrate(jar), true);
    assert.deepEqual(jar.entries, [{ name: key, value: session('shared'), scope: domain }]);
  }
});

test('identical host/shared values use multiset subtraction', () => {
  const value = session('same');
  const jar = cookieJar([[key, value, domain], [key, value]]);
  assert.equal(migrate(jar), true);
  assert.deepEqual(jar.entries, [{ name: key, value, scope: domain }]);
});

test('mixed root and chunks are ambiguous and existing shared chunks win', () => {
  const shared = session('shared');
  const half = Math.floor(shared.length / 2);
  const jar = cookieJar([[key, session('host')], [`${key}.0`, shared.slice(0, half), domain], [`${key}.1`, shared.slice(half), domain]]);
  assert.equal(hasDuplicateTestSessionCookies(jar.cookie, url), true);
  assert.equal(migrate(jar), true);
  assert.equal(jar.entries.length, 2);
  assert.equal(jar.entries.map(({ value }) => value).join(''), shared);
  assert.equal(hasDuplicateTestSessionCookies(jar.cookie, url), false);
});

test('host-only chunks migrate over malformed shared leftovers', () => {
  const host = session('host');
  const half = Math.floor(host.length / 2);
  const jar = cookieJar([[`${key}.0`, host.slice(0, half)], [`${key}.1`, host.slice(half)], [key, 'malformed', domain]]);
  assert.equal(migrate(jar), true);
  assert.equal(jar.entries.map(({ value }) => value).join(''), host);
  assert.ok(jar.entries.every(({ scope }) => scope === domain));
});

test('shared root plus obsolete shared chunks are normalized without a reload loop', () => {
  const jar = cookieJar([[key, session('shared'), domain], [`${key}.0`, 'obsolete', domain]]);
  assert.equal(migrate(jar), true);
  assert.deepEqual(jar.entries, [{ name: key, value: session('shared'), scope: domain }]);
  assert.equal(migrate(jar), false);
});

test('malformed or cross-project host cookies are removed without promotion', () => {
  for (const value of ['broken', session('other', 'https://uoatfgdxafvetninytuu.supabase.co/auth/v1')]) {
    const jar = cookieJar([[key, value]]);
    assert.equal(migrate(jar), true);
    assert.deepEqual(jar.entries, []);
    assert.equal(migrate(jar), false);
  }
});

test('migration is limited to HTTPS test hosts and the nonproduction project', () => {
  for (const overrides of [
    { environment: 'prod' }, { protocol: 'http:' }, { hostname: 'csms.ivoracharge.com' },
    { hostname: 'localhost' }, { cookieDomain: '' }, { supabaseUrl: 'https://uoatfgdxafvetninytuu.supabase.co' },
  ]) {
    const jar = cookieJar([[key, session('host')]]);
    const before = jar.cookie;
    assert.equal(migrate(jar, overrides), false);
    assert.equal(jar.cookie, before);
  }
});

test('browser and server test origins use host-only cookies on localhost and loopback', () => {
  for (const host of ['localhost', 'localhost:3000', 'console.localhost:3000', '127.0.0.1:3000', '[::1]:3000', '::1']) {
    assert.deepEqual(authCookieOptionsForHost(domain, 'test', host), { path: '/', sameSite: 'lax' });
  }
  assert.equal(authCookieOptionsForHost(domain, 'test', 'csms-test.ivoracharge.com').domain, domain);
  assert.equal(authCookieOptionsForHost(domain, 'prod', 'localhost:3000').domain, domain);
});

test('blocked cookie writes never cause repeated reloads', () => {
  const value = `${key}=broken`;
  const blocked = { get cookie() { return value; }, set cookie(_) {} };
  assert.equal(migrate(blocked), false);
  assert.equal(migrate(blocked), false);
});

test('parent-domain write rejection restores original host session without reload', () => {
  const jar = cookieJar([[key, session('host')]]);
  const original = jar.cookie;
  const guarded = {
    get cookie() { return jar.cookie; },
    set cookie(value) { if (!value.includes('Domain=')) jar.cookie = value; },
  };
  assert.equal(migrate(guarded), false);
  assert.equal(jar.cookie, original);
  assert.equal(migrate(guarded), false);
  assert.equal(jar.cookie, original);
});

test('unavailable cookie storage does not throw or reload', () => {
  const unavailable = { get cookie() { throw new Error('Cookies unavailable'); }, set cookie(_) { throw new Error('Cookies unavailable'); } };
  assert.equal(migrate(unavailable), false);
});

test('shared logout marker blocks resurrection of dormant host cookies and survives cleanup', () => {
  const marker = 'sb-qvytgefpcomloxlvuwur-test-sso-logged-out';
  const jar = cookieJar([[key, session('dormant')], [marker, '1', domain], [productionKey, 'production', domain]]);
  assert.equal(hasTestLogoutMarker(jar.cookie, url), true);
  assert.equal(migrate(jar), true);
  assert.deepEqual(jar.entries, [
    { name: marker, value: '1', scope: domain },
    { name: productionKey, value: 'production', scope: domain },
  ]);
  assert.equal(migrate(jar), false);
  assert.equal(hasTestLogoutMarker(jar.cookie, url), true);
});

test('explicit test sign-in clears the shared logout marker; production marker is never changed', () => {
  const jar = cookieJar([[productionKey, 'production', domain]]);
  const options = { environment: 'test', supabaseUrl: url, cookieDomain: domain,
    hostname: 'csms-test.ivoracharge.com', protocol: 'https:', cookies: jar };
  writeTestLogoutMarker(options, true);
  assert.equal(hasTestLogoutMarker(jar.cookie, url), true);
  writeTestLogoutMarker(options, false);
  assert.equal(hasTestLogoutMarker(jar.cookie, url), false);
  assert.deepEqual(jar.entries, [{ name: productionKey, value: 'production', scope: domain }]);
  writeTestLogoutMarker({ ...options, supabaseUrl: 'https://uoatfgdxafvetninytuu.supabase.co' }, true);
  assert.deepEqual(jar.entries, [{ name: productionKey, value: 'production', scope: domain }]);
});

test('logout cleanup with blocked cookie writes does not reload', () => {
  const value = `${key}=${session('dormant')}; sb-qvytgefpcomloxlvuwur-test-sso-logged-out=1`;
  const blocked = { get cookie() { return value; }, set cookie(_) {} };
  assert.equal(migrate(blocked), false);
});
