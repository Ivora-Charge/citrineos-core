// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0

/** Claims namespaces do not isolate accounts, password resets, or billing.
 * A test console must use its own Supabase project. Shared test cookies use
 * that project's distinct cookie name, never the production session name.
 */
export function assertTestEnvironment(
  environment: string | undefined,
  supabaseUrl: string | undefined,
  cookieDomain: string | undefined,
): void {
  if (environment !== 'test') return;
  if (!supabaseUrl) throw new Error('The test console requires an isolated Supabase URL');
  const url = new URL(supabaseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/'
  ) {
    throw new Error('The test console requires a Supabase origin without credentials, path, or query');
  }
  if (url.hostname.replace(/\.$/, '') === 'uoatfgdxafvetninytuu.supabase.co') {
    throw new Error('The test console cannot use the production Supabase project');
  }
  const domain = cookieDomain?.trim();
  if (domain && domain !== '.ivoracharge.com') {
    throw new Error('The test cookie domain must be empty or .ivoracharge.com');
  }
  if (domain && (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname))) {
    throw new Error('Shared test cookies require a separate hosted Supabase project');
  }
}
