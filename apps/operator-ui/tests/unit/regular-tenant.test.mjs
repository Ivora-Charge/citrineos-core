import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import {
  readCsmsClaims,
  hasFleetAccess,
  normalizeCsmsGrantRoles,
} from '../../src/lib/utils/csms-claims.ts';

const claimsUrl = new URL('../../src/lib/utils/csms-claims.ts', import.meta.url);
const coreUrl = new URL('../../src/lib/utils/core-access.ts', import.meta.url);
const coreSource = stripTypeScriptTypes(readFileSync(coreUrl, 'utf8')).replace(
  "'./csms-claims'",
  JSON.stringify(claimsUrl.href),
);
const { authorizeCoreRequest } = await import(
  `data:text/javascript;base64,${Buffer.from(coreSource).toString('base64')}`
);

test('regular access has exactly a viewer role and is bound to one environment and tenant', () => {
  assert.deepEqual(normalizeCsmsGrantRoles(['tenant-viewer']), ['tenant-viewer']);
  const payload = {
    app_metadata: { csms: { prod: { roles: ['tenant-viewer'], tenant_id: '7' } } },
  };
  assert.deepEqual(readCsmsClaims(payload, 'prod'), { roles: ['tenant-viewer'], tenantId: '7' });
  assert.equal(readCsmsClaims(payload, 'test'), null);
  assert.equal(hasFleetAccess(readCsmsClaims(payload, 'prod')), true);
  for (const tenant of [undefined, '', '0', '-1', '08', 'all', '8.5']) {
    payload.app_metadata.csms.prod.tenant_id = tenant;
    assert.equal(readCsmsClaims(payload, 'prod'), null);
  }
});

test('regular viewers cannot send commands or call core management routes, even on their own charger', () => {
  for (const roles of [['tenant-viewer']]) {
    const claims = { roles, tenantId: '7' };
    const requests = [
      [
        'POST',
        ['ocpp', '1.6', 'configuration', 'reset'],
        'tenantId=7&identifier=fixture-own',
        { type: 'Soft' },
      ],
      [
        'POST',
        ['ocpp', '2.0.1', 'evdriver', 'requestStartTransaction'],
        'tenantId=7&identifier=fixture-own',
        {},
      ],
      ['DELETE', ['data', 'ocpprouter', 'connection'], 'tenantId=7&ocppConnectionName=fixture-own'],
      [
        'POST',
        ['data', 'configuration', 'password'],
        'tenantId=7',
        { ocppConnectionName: 'fixture-own', password: 'fixture' },
      ],
      ['GET', ['data', 'ocpprouter', 'systemConfig'], 'tenantId=7'],
      ['GET', ['data', 'configuration', 'bootConfig'], 'tenantId=8'],
    ];
    for (const [method, path, query, body] of requests) {
      const result = authorizeCoreRequest(claims, method, path, new URLSearchParams(query), body);
      assert.equal(result.allowed, false, `${roles}/${method}/${path.join('/')}`);
      assert.equal(result.status, 403);
    }
  }
});

test('tenant management remains distinct from regular access', () => {
  const result = authorizeCoreRequest(
    { roles: ['tenant-admin'], tenantId: '7' },
    'POST',
    ['ocpp', '1.6', 'configuration', 'reset'],
    new URLSearchParams('tenantId=7&identifier=fixture-own'),
    { type: 'Soft' },
  );
  assert.deepEqual(result, { allowed: true, tenantId: '7', station: 'fixture-own' });
  const foreign = authorizeCoreRequest(
    { roles: ['tenant-admin'], tenantId: '7' },
    'POST',
    ['ocpp', '1.6', 'configuration', 'reset'],
    new URLSearchParams('tenantId=8&identifier=fixture-foreign'),
    { type: 'Soft' },
  );
  assert.equal(foreign.allowed, false);
});

 test('existing support-only and legacy mixed grants retain operational reads', () => {
  for (const roles of [['platform-support'], ['platform-support', 'tenant-viewer']]) {
    const claims = readCsmsClaims({ app_metadata: { csms: { prod: { roles } } } }, 'prod');
    assert.ok(claims);
    assert.equal(hasFleetAccess(claims), true);
    assert.equal(authorizeCoreRequest(claims, 'GET', ['data', 'configuration', 'bootConfig'], new URLSearchParams()).allowed, true);
    assert.equal(authorizeCoreRequest(claims, 'POST', ['ocpp', '1.6', 'configuration', 'reset'], new URLSearchParams(), {}).allowed, false);
  }
  assert.equal(authorizeCoreRequest({roles: ['platform-support']}, 'GET', ['data', 'tenant', 'tenant'], new URLSearchParams()).allowed, false);
});
