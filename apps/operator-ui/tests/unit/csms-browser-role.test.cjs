// Exercise the real browser auth provider with a synthetic signed-session shape.
// External authentication and UI boundaries are mocked; no network requests.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
let roles = [];
const mocks = {
  '@/lib/utils/config': {default: {csmsEnv: 'prod'}},
  '@lib/utils/config': {default: {csmsEnv: 'prod'}},
  '@lib/utils/jwt': {parseJwt: () => ({app_metadata: {csms: {prod: {roles, ...(roles.includes('tenant-viewer') && !roles.includes('platform-support') ? {tenant_id: '7'} : {})}}}})},
  '@lib/utils/platform-role-refresh': {createPlatformRoleRefreshGuard: () => ({refreshIfNeeded: async () => false})},
  '@lib/supabase/browser': {getBrowserSupabase: () => ({auth: {getSession: async () => ({data: {session: {access_token: 'synthetic'}}})}})},
  '@lib/providers/auth-provider/generic-auth-provider': {GenericLoginPage: () => null},
};
const cache = new Map();
function load(filename) {
  if (!fs.existsSync(filename)) filename += ['.ts', '.tsx'].find(ext => fs.existsSync(filename + ext)) || '';
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = {exports: {}}; cache.set(filename, module);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  }}).outputText;
  const localRequire = name => {
    if (mocks[name]) return {...mocks[name], __esModule: true};
    if (name.startsWith('@lib/')) return load(path.join(root, 'src/lib', name.slice(5)));
    if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name));
    return require(require.resolve(name, {paths: [root]}));
  };
  vm.runInNewContext('(function(require,module,exports){' + js + '\n})', {console, Map, Date, process: {env: {}}})(localRequire, module, module.exports);
  return module.exports;
}
const {createKeycloakAuthProvider} = load(path.join(root, 'src/lib/providers/auth-provider/keycloak-auth-provider/index.tsx'));
test('browser sends an actually granted Hasura role for support and regular users', async () => {
  for (const [assigned, expected] of [
    [['platform-support'], 'platform-support'],
    [['platform-support', 'tenant-viewer'], 'platform-support'],
    [['platform-support', 'tenant-admin', 'tenant-viewer'], 'tenant-admin'],
    [['tenant-viewer'], 'tenant-viewer'],
    [['admin', 'platform-admin', 'tenant-viewer'], 'admin'],
  ]) {
    roles = assigned;
    const provider = createKeycloakAuthProvider();
    const headers = await provider.getHasuraHeaders();
    assert.equal(headers.get('x-hasura-role'), expected, assigned.join(','));
    assert.ok(assigned.includes(headers.get('x-hasura-role')));
  }
});
