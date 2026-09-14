// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use server';

import { fetchFile } from '@lib/server/clients/file/fileAccess';
import config from '@lib/utils/config';
import { BucketType } from '@lib/utils/enums';
import { authedAction, type ActionResult } from '@lib/utils/action-guard';
import { S3_BUCKET_FILE_CONFIG, S3_BUCKET_FILE_CORE_CONFIG } from '@lib/utils/consts';
import { hasPlatformRole } from '@lib/utils/csms-claims';

const ALLOWED_FILE_KEYS: ReadonlySet<string> = new Set([
  `${BucketType.CORE}:${S3_BUCKET_FILE_CORE_CONFIG}`,
  `${'undefined'}:${S3_BUCKET_FILE_CONFIG}`,
]);

export async function fetchFileAction(
  fileKey: string,
  bucketType?: BucketType,
): Promise<ActionResult<any>> {
  return authedAction<any>(async (session) => {
    if (!fileKey) {
      throw new Error('Missing file key');
    }

    const bucketKey = `${bucketType ?? 'undefined'}:${fileKey}`;
    if (!ALLOWED_FILE_KEYS.has(bucketKey)) {
      throw new Error('File not found');
    }

    const bucket =
      bucketType === BucketType.CORE
        ? config.fileStorageType === 'gcp'
          ? config.gcpCloudStorageCoreBucketName
          : config.awsS3CoreBucketName
        : config.fileStorageType === 'gcp'
          ? config.gcpCloudStorageBucketName
          : config.awsS3BucketName;

    try {
      const stored = await fetchFile(fileKey, bucket);
      // Only these public connection-help fields are consumed by the modal.
      // Never serialize complete core/UI configuration into an action result.
      if (bucketType !== BucketType.CORE) {
        return {
          centralSystem: { host: stored?.centralSystem?.host },
          defaultTenantId: session.user.tenantId ? Number(session.user.tenantId) : null,
        };
      }
      const servers = stored?.util?.networkConnection?.websocketServers;
      return {
        util: { networkConnection: { websocketServers: Array.isArray(servers) ? servers.map((server: any) => ({
          id: server.id,
          port: server.port,
          protocols: Array.isArray(server.protocols) ? server.protocols.filter((value: unknown) => typeof value === 'string') : [],
          securityProfile: server.securityProfile,
          dynamicTenantResolution: server.dynamicTenantResolution,
          tenantPathMapping: Object.fromEntries(Object.entries(server.tenantPathMapping || {}).filter(([, tenantId]) =>
            hasPlatformRole(session.user.roles) || String(tenantId) === session.user.tenantId)),
        })) : [] } },
      };
    } catch (err: any) {
      console.error(`Failed to fetch file`, { fileKey, bucket, err });
      throw new Error('File not found');
    }
  });
}
