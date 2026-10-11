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
describe('S3AttachmentStorage public endpoint', () => {
  it('signs presigned PUTs with publicEndpoint when provided', async () => {
    const storage = new S3AttachmentStorage({
      bucket: 'test-bucket',
      region: 'us-east-1',
      endpoint: 'http://internal.s3.test:8333',
      publicEndpoint: 'https://s3.public.test',
      accessKeyId: 'AKIAEXAMPLEEXAMPLE',
      secretAccessKey: 'exampleexampleexampleexampleexample12',
    });
    const { url } = await storage.presignPut('k', 'image/jpeg', 300);
    expect(new URL(url).host).toBe('s3.public.test');
    expect(new URL(url).protocol).toBe('https:');
  });

  it('signs presigned GETs with publicEndpoint when provided', async () => {
    const storage = new S3AttachmentStorage({
      bucket: 'test-bucket',
      region: 'us-east-1',
      endpoint: 'http://internal.s3.test:8333',
      publicEndpoint: 'https://s3.public.test',
      accessKeyId: 'AKIAEXAMPLEEXAMPLE',
      secretAccessKey: 'exampleexampleexampleexampleexample12',
    });
    const { url } = await storage.presignGet('k', 300);
    expect(new URL(url).host).toBe('s3.public.test');
  });

  it('falls back to endpoint when publicEndpoint is omitted', async () => {
    const storage = new S3AttachmentStorage({
      bucket: 'test-bucket',
      region: 'us-east-1',
      endpoint: 'http://internal.s3.test:8333',
      accessKeyId: 'AKIAEXAMPLEEXAMPLE',
      secretAccessKey: 'exampleexampleexampleexampleexample12',
    });
    const { url } = await storage.presignPut('k', 'image/jpeg', 300);
    expect(new URL(url).host).toBe('internal.s3.test:8333');
  });
});