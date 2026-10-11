import { describe, expect, it } from 'vitest';
import { S3AttachmentStorage } from '../src/s3-attachment-storage.js';

describe('S3AttachmentStorage', () => {
  it('creates browser PUT URLs without an SDK-generated checksum requirement', async () => {
    const storage = new S3AttachmentStorage({
      bucket: 'attachments-test',
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:8333',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    });

    const result = await storage.presignPut(
      'tenant-test/attachment-test.txt',
      'text/plain',
      300,
    );
    const url = new URL(result.url);
    const queryKeys = [...url.searchParams.keys()].map((key) => key.toLowerCase());
    const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders') ?? '';

    expect(result.expiresIn).toBe(300);
    expect(queryKeys.some((key) => key.includes('checksum'))).toBe(false);
    expect(signedHeaders.toLowerCase()).not.toContain('checksum');
  });
});
