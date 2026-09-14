// Execute actual actions/guards with every external boundary mocked. No live
// credentials, networks, accounts, payment operations, or charger commands.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
let roles = ['tenant-viewer'];
const effects = [];
const external = async () => {
  effects.push('unexpected external call');
  throw new Error('External calls forbidden in this test');
};
const mocks = {
  '@lib/server/session': {
    getCsmsSession: async () => ({
      accessToken: 'fixture',
      user: { id: 'fixture', roles, tenantId: '7' },
    }),
    AuthUnavailableError: class extends Error {},
  },
  '@lib/utils/config': {
    default: { csmsEnv: 'test', authProvider: 'supabase', allowImageUpload: true },
  },
  '@lib/server/hasura': { hasuraAdmin: external },
  '@lib/server/audit': { audit: external },
  '@lib/server/supabase-admin': {
    findUserByEmail: external,
    inviteUser: external,
    listUsersForTenant: external,
    writeCsmsClaims: external,
  },
  '@lib/server/clients/file/fileAccess': {
    generatePresignedPutUrl: external,
    generatePresignedGetUrlIfExists: external,
  },
};
const cache = new Map();
function load(filename) {
  if (!fs.existsSync(filename))
    filename += ['.ts', '.tsx', '.js'].find((ext) => fs.existsSync(filename + ext)) || '';
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const localRequire = (name) => {
    if (mocks[name]) return { ...mocks[name], __esModule: true };
    if (name.startsWith('@lib/')) return load(path.join(root, 'src/lib', name.slice(5)));
    if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name));
    return require(require.resolve(name, { paths: [root] }));
  };
  vm.runInNewContext('(function(require,module,exports){' + js + '\n})', {
    console,
    fetch: external,
    process: { env: {} },
    Response,
    Headers,
    URL,
    AbortSignal,
  })(localRequire, module, module.exports);
  return module.exports;
}
const action = (file, name) => load(path.join(root, 'src/lib/server/actions', file))[name];
test('regular viewers and support/viewer combinations cannot invoke management actions', async () => {
  const cases = [
    [
      'syncPaymentCatalog.ts',
      'syncPaymentCatalogAction',
      [[{ evse_id: 'fixture' }], { tenantIdOverride: '7' }],
    ],
    ['syncTariffToPayment.ts', 'syncTariffToPaymentAction', [1, { tenantIdOverride: '7' }]],
    ['claimCharger.ts', 'claimChargerAction', [{ serialNumber: 'fixture', targetTenantId: '7' }]],
    ['claimCharger.ts', 'moveToInventoryAction', ['fixture']],
    ['claimCharger.ts', 'listInventoryAction', []],
    ['stripeConnect.ts', 'createStripeOnboardingLinkAction', [7]],
    ['stripeConnect.ts', 'setTenantPlatformFeeAction', [7, 100]],
    [
      'tenantUsers.ts',
      'inviteUserAction',
      [{ email: 'fixture@example.invalid', role: 'tenant-viewer', tenantId: '7' }],
    ],
    ['tenantUsers.ts', 'listTenantUsersAction', ['7']],
    [
      'file/uploadFileViaPresignedUrl.ts',
      'uploadFileViaPresignedUrl',
      [{ type: 'image/png', size: 1, name: 'fixture.png' }, 'images/ChargingStations/1'],
    ],
  ];
  for (const assigned of [['tenant-viewer'], ['platform-support', 'tenant-viewer']]) {
    roles = assigned;
    for (const [file, name, args] of cases) {
      effects.length = 0;
      const result = await action(file, name)(...args);
      assert.equal(result.success, false, `${assigned}/${name}`);
      assert.deepEqual(effects, [], `${name} must deny before reaching external services`);
    }
  }
});
