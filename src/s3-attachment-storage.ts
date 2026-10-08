import { S3Client, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { AttachmentStorage, PresignedPut, PresignedGet, HeadResult } from './attachment-storage.js';

export interface S3StorageOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class S3AttachmentStorage implements AttachmentStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region ?? 'us-east-1',
      endpoint: options.endpoint,
      forcePathStyle: !!options.endpoint,
      credentials: options.accessKeyId && options.secretAccessKey
        ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
        : undefined,
    });
  }

  async presignPut(objectKey: string, contentType: string, expiresIn: number): Promise<PresignedPut> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: contentType,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn });
    return { url, expiresIn };
  }

  async presignGet(objectKey: string, expiresIn: number): Promise<PresignedGet> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn });
    return { url, expiresIn };
  }

  async head(objectKey: string): Promise<HeadResult> {
    try {
      const res = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }));
      return {
        exists: true,
        sizeBytes: res.ContentLength,
        contentType: res.ContentType,
      };
    } catch {
      return { exists: false };
    }
  }

  /**
   * Deletes an object. Idempotent: S3 returns 204 for a missing key, so
   * a retry after a partial failure is harmless.
   */
  async delete(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    }));
  }

  /**
   * Lists every object under `prefix`, following S3 pagination until
   * exhaustion. Reads one page (up to 1000 keys) at a time and appends.
   * Synchronous return: for a per-tenant prefix the count is bounded by
   * the tenant's attachment volume, which a scan tolerates in memory.
   */
  async listByPrefix(prefix: string): Promise<{ key: string; sizeBytes: number }[]> {
    const out: { key: string; sizeBytes: number }[] = [];
    let continuationToken: string | undefined = undefined;
    do {
      const res: ListObjectsV2CommandOutput = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }));
      for (const obj of res.Contents ?? []) {
        if (obj.Key) out.push({ key: obj.Key, sizeBytes: obj.Size ?? 0 });
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
    return out;
  }
}
