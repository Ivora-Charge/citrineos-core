// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { BootstrapConfig, ConfigStore, SystemConfig } from '@citrineos/base';
import { Readable } from 'stream';
import type { ILogObj } from 'tslog';
import { Logger } from 'tslog';

export class S3Storage implements ConfigStore {
  protected readonly _logger: Logger<ILogObj>;
  private s3Client: S3Client;
  private defaultBucketName: string;
  private configFileName: string;
  private configBucketName: string | undefined;

  constructor(
    config: BootstrapConfig['fileAccess']['s3'],
    configFileName: string,
    configDir?: string,
    logger?: Logger<ILogObj>,
  ) {
    this.s3Client = new S3Client({
      // Endpoint required for Minio
      ...(config!.endpoint ? { endpoint: config!.endpoint } : {}),
      // Region required for AWS S3
      ...(config!.region ? { region: config!.region } : {}),
      // Only set forcePathStyle to true for Minio, use default (false) for AWS S3
      forcePathStyle: !!config?.s3ForcePathStyle,
      // Add credentials if explicitly provided
      ...(config!.accessKeyId && config!.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config!.accessKeyId,
              secretAccessKey: config!.secretAccessKey,
            },
          }
        : {}),
    });
    this.defaultBucketName = config!.defaultBucketName!;
    this.configFileName = configFileName!;
    this.configBucketName = configDir;
    this._logger = logger
      ? logger.getSubLogger({ name: this.constructor.name })
      : new Logger<ILogObj>({ name: this.constructor.name });
  }
  async saveFile(fileName: string, content: Buffer, filePath?: string): Promise<string> {
    const bucketName = filePath ? filePath : this.defaultBucketName;
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: fileName,
      Body: content,
      ContentType: 'application/octet-stream',
    });
    try {
      const result = await this.s3Client.send(command);

      if (result.$metadata.httpStatusCode !== 200) {
        throw new Error(`Failed to upload file ${fileName}: ${result.$metadata.httpStatusCode}`);
      } else {
        return fileName;
      }
    } catch (error: any) {
      if (error.name === 'NoSuchBucket' || error.$metadata?.httpStatusCode === 404) {
        this._logger.warn(`Bucket "${bucketName}" not found. Creating it...`);
        await this.createBucket(bucketName);
        this._logger.info(`Bucket "${bucketName}" created. Retrying config save...`);
        return await this.saveFile(fileName, content, filePath);
      } else {
        this._logger.error('Error saving config to S3:', error);
        throw error;
      }
    }
  }

  async getFile(id: string, filePath?: string): Promise<string | undefined> {
    const command = new GetObjectCommand({
      Bucket: filePath ? filePath : this.defaultBucketName,
      Key: id,
    });
    const { Body } = await this.s3Client.send(command);

    if (!Body) return;

    return await S3Storage.streamToString(Body as Readable);
  }

  async exists(path: string): Promise<boolean> {
    const command = new HeadObjectCommand({
      Bucket: this.defaultBucketName,
      Key: path,
    });
    try {
      await this.s3Client.send(command);
      return true;
    } catch (error: any) {
      if (
        error.name === 'NotFound' ||
        error.name === 'NoSuchKey' ||
        error.$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      this._logger.error(`Error checking existence of "${path}" in S3:`, error);
      throw error;
    }
  }

  // S3 has no concept of directories; object keys with "/" separators are
  // implicit, so a key can be written without first creating its prefix.
  // This is intentionally a no-op to satisfy the IFileStorage contract.
  async createDirectory(_path: string, _options?: { recursive?: boolean }): Promise<void> {
    return;
  }

  async deleteFile(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    try {
      if (options?.recursive) {
        await this.deletePrefix(path);
      } else {
        await this.s3Client.send(
          new DeleteObjectCommand({
            Bucket: this.defaultBucketName,
            Key: path,
          }),
        );
      }
    } catch (error: any) {
      const notFound =
        error.name === 'NotFound' ||
        error.name === 'NoSuchKey' ||
        error.$metadata?.httpStatusCode === 404;
      if (notFound && options?.force) {
        return;
      }
      this._logger.error(`Error deleting "${path}" from S3:`, error);
      throw error;
    }
  }

  async fetchConfig(): Promise<SystemConfig | null> {
    try {
      const configString = await this.getFile(this.configFileName, this.configBucketName);
      if (!configString) return null;
      return JSON.parse(configString) as SystemConfig;
    } catch (error: any) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        this._logger.warn('Config not found in S3.');
        return null;
      }
      this._logger.error('Error fetching config from S3:', error);
      throw error;
    }
  }

  async saveConfig(config: SystemConfig): Promise<void> {
    await this.saveFile(
      this.configFileName,
      Buffer.from(JSON.stringify(config, null, 2)),
      this.configBucketName,
    );
    this._logger.info('Config saved to S3.');
  }

  private async createBucket(bucket: string): Promise<void> {
    try {
      const command = new CreateBucketCommand({ Bucket: bucket });
      await this.s3Client.send(command);
      this._logger.info(`Bucket "${bucket}" created successfully.`);
    } catch (error) {
      this._logger.error(`Failed to create bucket "${bucket}":`, error);
      throw error;
    }
  }

  private static async streamToString(stream: Readable): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
  }

  // Deletes every object whose key starts with the given prefix, paging through
  // the listing in batches of up to 1000 (the S3 DeleteObjects limit).
  private async deletePrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const listed = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.defaultBucketName,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      const keys = (listed.Contents ?? [])
        .map((obj) => obj.Key)
        .filter((key): key is string => !!key);

      if (keys.length > 0) {
        await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: this.defaultBucketName,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          }),
        );
      }

      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}
