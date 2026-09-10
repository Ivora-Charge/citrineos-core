// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0

type Cookie = { name: string; value: string };
type CookieDocument = { cookie: string };
type MigrationOptions = {
  environment: string | undefined;
  supabaseUrl: string | undefined;
  cookieDomain: string | undefined;
  hostname: string;
  protocol: string;
  cookies: CookieDocument;
};

const TEST_HOSTS = new Set(['analytics-lab.ivoracharge.com', 'csms-test.ivoracharge.com']);
const PRODUCTION_PROJECT = 'uoatfgdxafvetninytuu';

function testCookieKey(supabaseUrl: string): string | null {
  try {
    const url = new URL(supabaseUrl);
    const project = url.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/)?.[1];
    if (url.protocol !== 'https:' || !project || project === PRODUCTION_PROJECT) return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return `sb-${project}-auth-token`;
  } catch {
    return null;
  }
}

function sessionCookies(header: string, key: string): Cookie[] {
  return header.split(';').flatMap((part) => {
    const index = part.indexOf('=');
    if (index < 0) return [];
    const name = part.slice(0, index).trim();
    if (name !== key && !(name.startsWith(`${key}.`) && /^\d+$/.test(name.slice(key.length + 1)))) return [];
    return [{ name, value: part.slice(index + 1).trim() }];
  });
}

function logoutMarkerName(key: string): string {
  return key.replace(/-auth-token$/, '-test-sso-logged-out');
}

export function hasTestLogoutMarker(header: string, supabaseUrl: string): boolean {
  const key = testCookieKey(supabaseUrl);
  return !!key && header.split(';').some((part) => part.trim() === `${logoutMarkerName(key)}=1`);
}

function migrationKey(options: MigrationOptions): string | null {
  const { environment, supabaseUrl, cookieDomain, hostname, protocol } = options;
  if (environment !== 'test' || cookieDomain !== '.ivoracharge.com' || protocol !== 'https:' || !TEST_HOSTS.has(hostname) || !supabaseUrl) return null;
  return testCookieKey(supabaseUrl);
}

/** A shared logout must also cover a dormant app's pre-migration host cookie.
 * Only an explicit successful sign-in clears this marker; session recovery
 * and automatic SIGNED_IN events must not resurrect that older session.
 */
export function writeTestLogoutMarker(options: MigrationOptions, loggedOut: boolean): void {
  const key = migrationKey(options);
  if (!key) return;
  try {
    options.cookies.cookie = `${logoutMarkerName(key)}=${loggedOut ? '1' : ''}; Domain=.ivoracharge.com; Path=/; Max-Age=${loggedOut ? 34560000 : 0}; SameSite=Lax; Secure`;
  } catch { /* Cookie access can be disabled by browser policy. */ }
}

/** The raw header preserves duplicate names which NextRequest.cookies loses.
 * Keep these requests out of token refresh until the browser removes the old
 * host-only copies, so an old refresh token cannot replace the shared login.
 */
export function hasDuplicateTestSessionCookies(header: string, supabaseUrl: string): boolean {
  const key = testCookieKey(supabaseUrl);
  if (!key) return false;
  const names = sessionCookies(header, key).map(({ name }) => name);
  return new Set(names).size !== names.length || (names.includes(key) && names.some((name) => name !== key));
}

function decodeJson(value: string): Record<string, unknown> {
  const text = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(text, (char) => char.charCodeAt(0))));
}

function coherentSession(cookies: Cookie[], key: string, issuer: string): Cookie[] | null {
  if (cookies.length === 0 || new Set(cookies.map(({ name }) => name)).size !== cookies.length) return null;
  const root = cookies.find(({ name }) => name === key);
  const chunks = cookies.filter(({ name }) => name !== key)
    .sort((a, b) => Number(a.name.slice(key.length + 1)) - Number(b.name.slice(key.length + 1)));
  const candidates = root ? [[root]] : [];
  if (chunks.length && chunks.every(({ name }, index) => name === `${key}.${index}`)) candidates.push(chunks);
  for (const chosen of candidates) {
    try {
      const raw = chosen.map(({ value }) => decodeURIComponent(value)).join('');
      const session = raw.startsWith('base64-') ? decodeJson(raw.slice(7)) : JSON.parse(raw);
      if (typeof session?.access_token !== 'string' || typeof session?.refresh_token !== 'string' || !session.refresh_token) continue;
      // This is only a scope migration, never an authentication decision. The
      // SDK and server still verify the token. Reject obvious cross-project data.
      if (decodeJson(session.access_token.split('.')[1] ?? '').iss !== issuer) continue;
      return chosen;
    } catch {
      // An obsolete root cookie must not hide an otherwise complete chunk set.
    }
  }
  return null;
}

/** Promote only this test project's old host-only cookies. Existing complete
 * shared cookies win, including a login created on the other test app.
 * Returns whether host-only cookies were removed, for a one-time page reload.
 */
export function migrateTestAuthCookies(options: MigrationOptions): boolean {
  const { supabaseUrl, cookies } = options;
  const key = migrationKey(options);
  if (!key || !supabaseUrl) return false;
  let savedHost: Cookie[] = [];
  try {
  const before = sessionCookies(cookies.cookie, key);
  if (!before.length) return false;
  if (hasTestLogoutMarker(cookies.cookie, supabaseUrl)) {
    for (const name of new Set(before.map((cookie) => cookie.name))) {
      cookies.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
      cookies.cookie = `${name}=; Domain=.ivoracharge.com; Path=/; Max-Age=0; SameSite=Lax; Secure`;
    }
    // Never restore a session after an intentional logout, even if a cookie
    // was left on this host before either product migrated to shared cookies.
    return sessionCookies(cookies.cookie, key).length < before.length;
  }

  // No Domain deletes only this subdomain's host cookie, leaving the shared
  // parent-domain copy intact. Do not touch cookies for any other project.
  for (const name of new Set(before.map((cookie) => cookie.name))) {
    cookies.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
  }
  const shared = sessionCookies(cookies.cookie, key);
  // Subtract matching name/value occurrences, not just names: duplicate
  // host/domain cookies may carry the same value or different sized sessions.
  const remaining = [...shared];
  const hostOnly = before.filter((cookie) => {
    const index = remaining.findIndex((other) => other.name === cookie.name && other.value === cookie.value);
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
  savedHost = hostOnly;
  const signature = (items: Cookie[]) => items.map(({ name, value }) => `${name}=${value}`).sort().join(';');
  const issuer = `${supabaseUrl.replace(/\/$/, '')}/auth/v1`;
  const sharedSession = coherentSession(shared, key, issuer);
  if (sharedSession) {
    const chosenNames = new Set(sharedSession.map(({ name }) => name));
    const stale = shared.filter(({ name }) => !chosenNames.has(name));
    for (const { name } of stale) {
      cookies.cookie = `${name}=; Domain=.ivoracharge.com; Path=/; Max-Age=0; SameSite=Lax; Secure`;
    }
    const after = sessionCookies(cookies.cookie, key);
    return hostOnly.length > 0 || signature(after) !== signature(before);
  }
  const oldSession = coherentSession(hostOnly, key, issuer);
  // Remove malformed shared leftovers too; otherwise middleware's ambiguity
  // check could keep routing a broken root/chunk combination back to login.
  for (const name of new Set(shared.map((cookie) => cookie.name))) {
    cookies.cookie = `${name}=; Domain=.ivoracharge.com; Path=/; Max-Age=0; SameSite=Lax; Secure`;
  }
  for (const { name, value } of oldSession ?? []) {
    cookies.cookie = `${name}=${value}; Domain=.ivoracharge.com; Path=/; Max-Age=34560000; SameSite=Lax; Secure`;
  }
  const after = sessionCookies(cookies.cookie, key);
  if (oldSession && !coherentSession(after, key, issuer)) {
    // Some browser policies allow host cookies but reject parent-domain
    // writes. Preserve that session and do not trigger a reload loop.
    for (const { name, value } of oldSession) {
      cookies.cookie = `${name}=${value}; Path=/; Max-Age=34560000; SameSite=Lax; Secure`;
    }
    return false;
  }
  return hostOnly.length > 0 || signature(after) !== signature(before);
  } catch {
    for (const { name, value } of savedHost) {
      try {
        cookies.cookie = `${name}=${value}; Path=/; Max-Age=34560000; SameSite=Lax; Secure`;
      } catch { /* Cookies are unavailable in this browser context. */ }
    }
    return false;
  }
}
