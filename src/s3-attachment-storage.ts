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
      // AWS SDK v3 >= 3.729.0 attaches a CRC32 checksum to PutObject by
      // default. For direct operations (head, delete, list) this option
      // stops the SDK from computing one. It does NOT cover the
      // presigner: that path has its own middleware. The fix for
      // presigned URLs lives in presignPut, using unhoistableHeaders.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async presignPut(objectKey: string, contentType: string, expiresIn: number): Promise<PresignedPut> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: contentType,
    });

    // AWS SDK v3 >= 3.729.0 attaches a flexible checksum (CRC32 by
    // default) to PutObject. The presigner hoists the checksum into the
    // query string as x-amz-checksum-crc32=AAAAAA== — the CRC32 of an
    // empty body, because there is no body at signing time. A client
    // that then PUTs real bytes gets BadDigest from S3-compatible
    // stores that enforce the checksum (SeaweedFS, Wasabi, Cloudflare
    // R2).
    //
    // Neither requestChecksumCalculation: 'WHEN_REQUIRED' on the client
    // nor unsignableHeaders on getSignedUrl covers this path. The
    // presigner has its own middleware, and the checksum is a query
    // param, not a header. unhoistableHeaders is the option that
    // actually prevents the SDK from moving the checksum header into
    // the query string.
    const url = await getSignedUrl(this.client, command, {
      expiresIn,
      unhoistableHeaders: new Set([
        'x-amz-checksum-crc32',
        'x-amz-sdk-checksum-algorithm',
      ]),
    });
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
      const res = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
        }),
      );

      return {
        exists: true,
        sizeBytes: res.ContentLength,
        contentType: res.ContentType,
      };
    } catch (error: unknown) {
      const e = error as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };

      if (
        e.name === 'NotFound' ||
        e.name === 'NoSuchKey' ||
        e.$metadata?.httpStatusCode === 404
      ) {
        return { exists: false };
      }

      // Any other failure (auth, network, 5xx, throttling) is a real
      // outage, not an absence. Rethrow so the caller does not silently
      // treat a live object as missing and skip its cleanup.
      throw error;
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
