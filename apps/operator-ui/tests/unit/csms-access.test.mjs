import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const policyUrl = new URL('../../src/lib/utils/csms-access.ts', import.meta.url);
const claimsUrl = new URL('../../src/lib/utils/csms-claims.ts', import.meta.url);
const source = stripTypeScriptTypes(readFileSync(policyUrl, 'utf8')).replace(
  "'./csms-claims'",
  JSON.stringify(claimsUrl.href),
);
const { csmsAccessDenied, csmsPageDenied } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

test('support cannot enter any tenant or business page, including direct links', () => {
  for (const pathname of [
    '/tenants',
    '/tenants/1',
    '/tenants/create',
    '/settings/business',
    '/settings/business/',
  ]) {
    assert.equal(csmsPageDenied(['platform-support'], pathname), true, pathname);
    assert.equal(csmsPageDenied(['platform-admin', 'admin'], pathname), false, pathname);
  }
  assert.equal(csmsPageDenied(['platform-support'], '/overview'), false);
  assert.equal(csmsPageDenied(['tenant-admin'], '/settings/business'), false);
  assert.equal(csmsPageDenied(['tenant-admin'], '/tenants'), true);
});

test('support retains fleet reads without tenant profiles or writes', () => {
  for (const action of ['list', 'show', 'access', 'create', 'edit', 'delete', 'command']) {
    assert.ok(csmsAccessDenied(['platform-support'], 'Tenants', action), action);
  }
  for (const action of ['list', 'show', 'access']) {
    assert.equal(csmsAccessDenied(['platform-support'], 'ChargingStations', action), undefined);
  }
  for (const action of ['create', 'edit', 'delete', 'command']) {
    assert.ok(csmsAccessDenied(['platform-support'], 'ChargingStations', action));
    assert.ok(csmsAccessDenied(['tenant-viewer'], 'ChargingStations', action));
  }
});

test('regular tenant access permits viewing and denies every management action', () => {
  for (const roles of [['tenant-viewer'], ['platform-support', 'tenant-viewer']]) {
    for (const resource of [
      'ChargingStations',
      'Transactions',
      'Locations',
      'Connectors',
      'Evses',
    ]) {
      for (const action of ['list', 'show', 'access']) {
        assert.equal(
          csmsAccessDenied(roles, resource, action),
          undefined,
          `${roles}/${resource}/${action}`,
        );
      }
      for (const action of ['create', 'edit', 'delete', 'command']) {
        assert.ok(csmsAccessDenied(roles, resource, action), `${roles}/${resource}/${action}`);
      }
    }
    for (const pathname of [
      '/tenants',
      '/tenants/create',
      '/fleet',
      '/fleet/',
      '/settings/platform',
      '/settings/platform/',
      '/settings/platform/nested',
      '/settings/business',
    ]) {
      assert.equal(csmsPageDenied(roles, pathname), true, pathname);
    }
    assert.equal(csmsPageDenied(roles, '/overview'), false);
    assert.equal(csmsPageDenied(roles, '/charging-stations'), false);
    assert.equal(!!csmsAccessDenied(roles, 'OCPPMessages', 'list'), !roles.includes('platform-support'));
  }
});

test('regular users cannot enter create/edit forms by URL but can still view charger details', () => {
  for (const roles of [['tenant-viewer'], ['platform-support', 'tenant-viewer']]) {
    for (const resource of ['charging-stations', 'locations', 'authorizations', 'partners', 'tariffs']) {
      for (const suffix of ['/new', '/new/', '/7/edit', '/7/edit/']) {
        const pathname = `/${resource}${suffix}`;
        assert.equal(csmsPageDenied(roles, pathname), true, pathname);
        assert.equal(csmsPageDenied(['tenant-admin'], pathname), false, pathname);
        assert.equal(csmsPageDenied(['platform-admin'], pathname), false, pathname);
      }
      assert.equal(csmsPageDenied(roles, `/${resource}/7`), false);
    }
    assert.equal(csmsPageDenied(roles, '/charging-stations/edit'), false);
  }
});

test('administrator and tenant boundaries remain intact, including multi-role grants', () => {
  assert.equal(csmsAccessDenied(['tenant-admin'], 'Tenants', 'edit'), undefined);
  assert.ok(csmsAccessDenied(['tenant-admin'], 'Tenants', 'list'));
  assert.equal(csmsAccessDenied(['platform-admin', 'admin'], 'Tenants', 'list'), undefined);
  assert.equal(
    csmsAccessDenied(['platform-support', 'tenant-admin'], 'Tenants', 'edit'),
    undefined,
  );
  assert.ok(csmsAccessDenied([], 'ChargingStations', 'list'));
});
