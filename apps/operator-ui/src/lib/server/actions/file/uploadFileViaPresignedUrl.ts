// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use server';

import { authedActionWithRoles, type ActionResult } from '@lib/utils/action-guard';
import { MUTATING_ROLES } from '@lib/utils/csms-claims';
import { assertImageAccess } from './imageAccess';

/*
 * Uploads a file to S3 bucket using a presigned URL
 * @param file - The file to upload
 * @param fileName - The name of the file. If it is undefined, the original file name will be used
 * @returns The key of the uploaded file
 */

import { generatePresignedPutUrl } from '@lib/server/clients/file/fileAccess';
import config from '@lib/utils/config';

export async function uploadFileViaPresignedUrl(
  file: File,
  fileName?: string,
): Promise<ActionResult<string>> {
  return authedActionWithRoles<string>(MUTATING_ROLES, async (session) => {
    if (!config.allowImageUpload) throw new Error('Image upload is disabled');
    if (!file || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) ||
        !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 5 * 1024 * 1024) {
      throw new Error('Upload a JPEG, PNG, WebP or GIF image no larger than 5 MB');
    }
    const objectKey = fileName || file.name;
    await assertImageAccess(session, objectKey);
    // Get signed URL
    const { url, key } = await generatePresignedPutUrl(objectKey, file.type);

    // Upload file using signed URL
    const uploadRes = await fetch(url, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type },
      signal: AbortSignal.timeout(10_000),
    });
    if (!uploadRes.ok) {
      throw new Error('Failed to upload file');
    }

    return key;
  });
}
