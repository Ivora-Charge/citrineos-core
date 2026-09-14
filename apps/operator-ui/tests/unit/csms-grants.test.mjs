import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCsmsGrantRoles, readCsmsClaims } from '../../src/lib/utils/csms-claims.ts';
import { createPlatformRoleRefreshGuard } from '../../src/lib/utils/platform-role-refresh.ts';

test('explicit platform-admin grants include Hasura admin and its default baseline', () => {
  const original = ['platform-admin'];
  assert.deepEqual(normalizeCsmsGrantRoles(original), ['platform-admin', 'admin', 'tenant-viewer']);
  assert.deepEqual(original, ['platform-admin']);
  const canonical = ['platform-admin', 'tenant-viewer', 'admin'];
  assert.deepEqual(normalizeCsmsGrantRoles(canonical), canonical);
});

test('tenant and support grants never acquire administrative capabilities', () => {
  for (const roles of [['tenant-admin'], ['tenant-viewer'], ['platform-support'], ['tenant-admin', 'platform-support']]) {
    const normalized = normalizeCsmsGrantRoles(roles);
    assert.equal(normalized.includes('admin'), false);
    assert.equal(normalized.includes('platform-admin'), false);
    assert.equal(normalized.includes('tenant-viewer'), roles.some(role => role !== 'platform-support'));
  }
  assert.deepEqual(normalizeCsmsGrantRoles([]), []);
  assert.ok(normalizeCsmsGrantRoles(['unknown-role']).includes('unknown-role'));
});

test('role normalization leaves tenant and environment boundaries intact', () => {
  const grant = { roles: ['tenant-admin'], tenant_id: '14' };
  const claims = { app_metadata: { csms: { test: { ...grant, roles: normalizeCsmsGrantRoles(grant.roles) } } } };
  assert.deepEqual(readCsmsClaims(claims, 'test'), { roles: ['tenant-admin', 'tenant-viewer'], tenantId: '14' });
  assert.equal(readCsmsClaims(claims, 'prod'), null);
  assert.equal(readCsmsClaims({ app_metadata: { csms: { test: { roles: normalizeCsmsGrantRoles(['tenant-admin']) } } } }, 'test'), null);
});

test('stale platform role repair deduplicates concurrent requests and attempts only once', async () => {
  const guard = createPlatformRoleRefreshGuard();
  let calls = 0, finish;
  const refresh = () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); };
  const first = guard.refreshIfNeeded(['platform-admin', 'tenant-viewer'], refresh);
  const second = guard.refreshIfNeeded(['platform-admin'], refresh);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(await guard.refreshIfNeeded(['platform-admin'], refresh), false);
  assert.equal(calls, 1);
});

test('a normal signed token is refreshed too so revoked roles are not kept until expiry', async () => {
  const guard = createPlatformRoleRefreshGuard();
  let calls = 0;
  assert.equal(await guard.refreshIfNeeded(['platform-admin', 'admin'], async () => { calls++; }), true);
  for (const roles of [undefined, [], ['admin'], ['platform-admin', 'admin'], ['tenant-admin'], ['platform-support']]) {
    assert.equal(await guard.refreshIfNeeded(roles, () => { throw new Error('must not refresh'); }), false);
  }
  assert.equal(calls, 1);
});

test('support-only ignores a leftover home tenant without gaining a tenant role', () => {
  const roles = normalizeCsmsGrantRoles(['platform-support']);
  assert.deepEqual(roles, ['platform-support']);
  assert.deepEqual(readCsmsClaims({ app_metadata: { csms: { prod: { roles, tenant_id: '8' } } } }, 'prod'), { roles });
});

test('failed repair does not loop; an explicit new sign-in permits another attempt', async () => {
  const guard = createPlatformRoleRefreshGuard();
  let calls = 0;
  const refresh = async () => { calls += 1; throw new Error('unavailable'); };
  assert.equal(await guard.refreshIfNeeded(['platform-admin'], refresh), true);
  assert.equal(await guard.refreshIfNeeded(['platform-admin'], refresh), false);
  assert.equal(calls, 1);
  guard.resetAfterExplicitSignIn();
  assert.equal(await guard.refreshIfNeeded(['platform-admin'], refresh), true);
  assert.equal(calls, 2);
});
