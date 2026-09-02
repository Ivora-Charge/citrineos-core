// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { type AuthProviderType, AuthProviderTypeEnum } from '../providers/auth-provider/types';

const getConfig: () => {
  appName: string;
  googleMapsApiKey: string;
  googleMapsAddressApiKey: string;
  googleMapsLocationPickerMapId?: string;
  googleMapsOverviewMapId?: string;
  defaultMapCenterLatitude: number;
  defaultMapCenterLongitude: number;
  hasuraAdminSecret?: string; // Not recommended for use in production; use your authProvider instead.
  hasuraClaim?: string;
  tenantId: string;
  apiUrl: string;
  wsUrl: string;
  bannerMessage?: string;
  citrineCoreUrl?: string; // What the BROWSER calls. Set to /api/core so it goes through the authenticated proxy (app/api/core/[...path]/route.ts).
  citrineCoreInternalUrl?: string; // SERVER ONLY. Where the Next.js server reaches CitrineOS core (e.g. http://citrine:8080). Never the public URL.
  fileServer?: string;
  logoUrl?: string;
  launcherUrl?: string; // Where the sidebar logo goes: the analytics launcher for this environment. Inlined at build.
  metricsUrl?: string;
  adminEmail?: string;
  adminPassword?: string;
  authProvider: AuthProviderType;
  supabaseUrl?: string; // Supabase project URL, e.g. https://<ref>.supabase.co
  supabaseAnonKey?: string; // Publishable anon key, safe in the browser bundle.
  supabaseServiceRoleKey?: string; // SERVER ONLY. Never expose to the browser.
  csmsEnv?: string; // SERVER ONLY. Which subtree of app_metadata.csms this box reads: "test" or "prod".
  awsRegion?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string; // Optional. Needed for temporary credentials
  awsS3BucketName?: string;
  awsS3CoreBucketName?: string;
  fileStorageType?: string;
  gcpCloudStorageBucketName?: string;
  gcpCloudStorageCoreBucketName?: string;
  allowImageUpload: boolean;
  paymentServiceUrl?: string; // Base URL of citrineos-payment, e.g. http://localhost:9010
} = () => {
  const authProviderResult = AuthProviderTypeEnum.safeParse(process.env.NEXT_PUBLIC_AUTH_PROVIDER);
  const authProvider = authProviderResult.success ? authProviderResult.data : 'generic';

  // NEXT_PUBLIC_* are inlined by `next build`; changing them in compose without
  // rebuilding the image changes nothing the browser sees.

  // Fail closed on a public box. The generic provider is a fail-open dev
  // login (no real token, middleware disabled, Hasura admin secret handed to
  // the browser), and a mistyped NEXT_PUBLIC_AUTH_PROVIDER silently falls back
  // to it -- so a production server must refuse to start in that state.
  // Likewise, Supabase claims are namespaced per environment
  // (app_metadata.csms[CSMS_ENV]); without CSMS_ENV nobody could log in, and a
  // wrong guess would read another environment's grants.
  //
  // Server only: NODE_ENV / CSMS_ENV are not in the browser bundle. Skipped
  // during `next build` (NEXT_PHASE=phase-production-build), which runs with
  // NODE_ENV=production but without the runtime environment.
  if (
    typeof window === 'undefined' &&
    process.env.NODE_ENV === 'production' &&
    process.env.NEXT_PHASE !== 'phase-production-build'
  ) {
    if (!process.env.NEXT_PUBLIC_AUTH_PROVIDER) {
      throw new Error(
        'NEXT_PUBLIC_AUTH_PROVIDER is unset in production; refusing to start with the fail-open generic provider',
      );
    }
    if (authProvider === 'generic') {
      throw new Error(
        `Auth provider resolved to 'generic' in production (NEXT_PUBLIC_AUTH_PROVIDER=${process.env.NEXT_PUBLIC_AUTH_PROVIDER}); refusing to start`,
      );
    }
    if (authProvider === 'supabase' && !process.env.CSMS_ENV) {
      throw new Error(
        'CSMS_ENV is unset in production; it selects the app_metadata.csms.<env> claims subtree this box trusts (test|prod)',
      );
    }
    // The browser bundle carries its own copy (NEXT_PUBLIC_CSMS_ENV, inlined
    // at build) so the UI can read the same claims subtree the server
    // enforces. An image built for one environment must not run as another.
    if (
      authProvider === 'supabase' &&
      process.env.NEXT_PUBLIC_CSMS_ENV &&
      process.env.NEXT_PUBLIC_CSMS_ENV !== process.env.CSMS_ENV
    ) {
      throw new Error(
        `NEXT_PUBLIC_CSMS_ENV (${process.env.NEXT_PUBLIC_CSMS_ENV}, baked into this image) does not match CSMS_ENV (${process.env.CSMS_ENV}); refusing to start`,
      );
    }
  }

  return {
    appName: process.env.NEXT_PUBLIC_APP_NAME || 'Ivora Charge',
    bannerMessage: process.env.NEXT_PUBLIC_BANNER_MESSAGE,
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || 'YOUR_GOOGLE_MAPS_API_KEY',
    googleMapsAddressApiKey:
      process.env.GOOGLE_MAPS_ADDRESS_API_KEY || 'YOUR_GOOGLE_MAPS_ADDRESS_API_KEY',
    googleMapsLocationPickerMapId:
      process.env.NEXT_PUBLIC_GOOGLE_MAPS_LOCATION_PICKER_MAP_ID || 'location-picker-map-id',
    googleMapsOverviewMapId:
      process.env.NEXT_PUBLIC_GOOGLE_MAPS_OVERVIEW_MAP_ID || 'overview-map-id',
    defaultMapCenterLatitude: process.env.NEXT_PUBLIC_DEFAULT_MAP_CENTER_LATITUDE
      ? parseFloat(process.env.NEXT_PUBLIC_DEFAULT_MAP_CENTER_LATITUDE)
      : 39.833333, // Approximate center of contiguous USA
    defaultMapCenterLongitude: process.env.NEXT_PUBLIC_DEFAULT_MAP_CENTER_LONGITUDE
      ? parseFloat(process.env.NEXT_PUBLIC_DEFAULT_MAP_CENTER_LONGITUDE)
      : -98.583333, // Approximate center of contiguous USA
    hasuraAdminSecret: process.env.HASURA_ADMIN_SECRET,
    hasuraClaim: process.env.NEXT_PUBLIC_HASURA_CLAIM || 'https://hasura.io/jwt/claims',
    tenantId: process.env.NEXT_PUBLIC_TENANT_ID || '1',
    apiUrl: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8090/v1/graphql',
    wsUrl: process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8090/v1/graphql',
    citrineCoreUrl: process.env.NEXT_PUBLIC_CITRINE_CORE_URL,
    citrineCoreInternalUrl: process.env.CITRINE_CORE_INTERNAL_URL,
    fileServer: process.env.NEXT_PUBLIC_FILE_SERVER_URL,
    logoUrl: process.env.NEXT_PUBLIC_LOGO_URL,
    launcherUrl: process.env.NEXT_PUBLIC_LAUNCHER_URL,
    metricsUrl: process.env.NEXT_PUBLIC_METRICS_URL,
    adminEmail: process.env.NEXT_PUBLIC_ADMIN_EMAIL,
    adminPassword: process.env.ADMIN_PASSWORD,
    authProvider,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    // Server: CSMS_ENV (runtime). Browser: NEXT_PUBLIC_CSMS_ENV (build time);
    // the production check above guarantees the two agree.
    csmsEnv: process.env.CSMS_ENV || process.env.NEXT_PUBLIC_CSMS_ENV,
    awsRegion: process.env.AWS_REGION || 'us-east-1',
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    awsSessionToken: process.env.AWS_SESSION_TOKEN,
    fileStorageType: process.env.FILE_STORAGE_TYPE || 's3',
    gcpCloudStorageBucketName: process.env.GCP_CLOUD_STORAGE_BUCKET_NAME,
    gcpCloudStorageCoreBucketName: process.env.GCP_CLOUD_STORAGE_CORE_BUCKET_NAME,
    awsS3BucketName: process.env.AWS_S3_BUCKET_NAME || 'YOUR_AWS_S3_BUCKET_NAME',
    awsS3CoreBucketName: process.env.AWS_S3_CORE_BUCKET_NAME || 'YOUR_AWS_S3_CORE_BUCKET_NAME',
    allowImageUpload: process.env.ALLOW_IMAGE_UPLOAD === 'true',
    paymentServiceUrl: process.env.NEXT_PUBLIC_PAYMENT_SERVICE_URL,
  };
};

export default getConfig();
