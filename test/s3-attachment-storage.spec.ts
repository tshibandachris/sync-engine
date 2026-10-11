import { describe, expect, it } from 'vitest';
import { S3AttachmentStorage } from '../src/s3-attachment-storage.js';

// Hors ligne : la signature d'une URL presignee ne fait aucun appel reseau.
// Les identifiants et l'endpoint sont fictifs.
const storage = new S3AttachmentStorage({
  bucket: 'test-bucket',
  region: 'us-east-1',
  endpoint: 'http://s3.example.test:8333',
  accessKeyId: 'AKIAEXAMPLEEXAMPLE',
  secretAccessKey: 'exampleexampleexampleexampleexample12',
});

describe('URL presignee PUT et checksums du SDK', () => {
  it("n'embarque aucun parametre de checksum (x-amz-checksum-*, x-amz-sdk-checksum-algorithm)", async () => {
    const { url } = await storage.presignPut('tenants/t1/checkins/c1/photo.jpg', 'image/jpeg', 300);
    const names = [...new URL(url).searchParams.keys()].map((k) => k.toLowerCase());
    const checksumParams = names.filter(
      (n) => n.startsWith('x-amz-checksum') || n === 'x-amz-sdk-checksum-algorithm',
    );
    // Un client mobile ne peut pas deviner ces valeurs : un store S3-compatible
    // qui les recoit refuse l'envoi (BadDigest). Voir unhoistableHeaders.
    expect(checksumParams).toEqual([]);
  });

  it('reste une URL presignee V4 valide et expirante', async () => {
    const { url } = await storage.presignPut('tenants/t1/checkins/c1/photo.jpg', 'image/jpeg', 300);
    const params = new URL(url).searchParams;
    expect(params.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(params.get('X-Amz-Expires')).toBe('300');
    expect(params.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });
});
