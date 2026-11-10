import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Inject, UnauthorizedException,
} from '@nestjs/common';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import type { EnrollDeviceDto } from './device-enrollment.dto.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const PROOF_MAX_BYTES = 8192;
const SIGNATURE_BYTES = 64;
const CLOCK_SKEW_SECONDS = 60;
const ENROLLMENT_PATH = '/api/v1/devices/enroll';

interface InitialProofPayload {
  jti: string; htm: string; htu: string; iat: number; code_hash: string; fingerprint: string; device_id: string;
}

function decodeCanonicalBase64Url(segment: string): Buffer {
  if (!segment || !BASE64URL_RE.test(segment)) throw new BadRequestException({ code: 'MALFORMED_INITIAL_PROOF', message: 'Invalid base64url segment.' });
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) throw new BadRequestException({ code: 'MALFORMED_INITIAL_PROOF', message: 'Non-canonical base64url segment.' });
  return decoded;
}

function parseJsonObject(buffer: Buffer, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(buffer.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object.');
    return value as Record<string, unknown>;
  } catch {
    throw new BadRequestException({ code: 'INVALID_INITIAL_PROOF', message: label + ' must be a JSON object.' });
  }
}

function hasExactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

@Injectable()
export class DeviceEnrollmentService {
  constructor(@Inject('DRIZZLE_DB') private readonly db: NodePgDatabase<typeof schema>) {}

  private verifyInitialProof(dto: EnrollDeviceDto, hardwareId: string): string {
    if (typeof dto.publicKeyPem !== 'string' || dto.publicKeyPem.length > 4096 ||
        !dto.publicKeyPem.includes('-----BEGIN PUBLIC KEY-----') ||
        !dto.publicKeyPem.includes('-----END PUBLIC KEY-----')) {
      throw new BadRequestException({ code: 'INVALID_DEVICE_PUBLIC_KEY', message: 'A bounded SPKI public key PEM is required.' });
    }
    if (typeof dto.initialProof !== 'string' || Buffer.byteLength(dto.initialProof, 'utf8') > PROOF_MAX_BYTES) {
      throw new BadRequestException({ code: 'INVALID_INITIAL_PROOF', message: 'Initial proof is missing or exceeds 8 KiB.' });
    }
    if (typeof dto.fingerprint !== 'string' || dto.fingerprint !== hardwareId) {
      throw new UnauthorizedException({ code: 'FINGERPRINT_MISMATCH', message: 'Body fingerprint must match X-Device-Fingerprint.' });
    }

    let publicKey: ReturnType<typeof createPublicKey>;
    try {
      publicKey = createPublicKey(dto.publicKeyPem);
      const jwk = publicKey.export({ format: 'jwk' });
      if (publicKey.asymmetricKeyType !== 'ec' || jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error('Only P-256 is accepted.');
    } catch {
      throw new BadRequestException({ code: 'INVALID_DEVICE_PUBLIC_KEY', message: 'The public key must be a valid EC P-256 SPKI PEM.' });
    }

    const segments = dto.initialProof.split('.');
    if (segments.length !== 3) throw new BadRequestException({ code: 'MALFORMED_INITIAL_PROOF', message: 'Compact JWS must contain exactly three segments.' });
    const [headerB64, payloadB64, signatureB64] = segments;
    const header = parseJsonObject(decodeCanonicalBase64Url(headerB64), 'JWS header');
    if (!hasExactKeys(header, ['alg', 'typ']) || header.alg !== 'ES256' || header.typ !== 'dpop+jwt') {
      throw new UnauthorizedException({ code: 'INVALID_INITIAL_PROOF_HEADER', message: 'Only ES256 dpop+jwt is accepted.' });
    }

    const payload = parseJsonObject(decodeCanonicalBase64Url(payloadB64), 'JWS payload') as unknown as InitialProofPayload;
    if (!hasExactKeys(payload, ['jti', 'htm', 'htu', 'iat', 'code_hash', 'fingerprint', 'device_id']) ||
        typeof payload.jti !== 'string' || !UUID_RE.test(payload.jti) ||
        typeof payload.htm !== 'string' || typeof payload.htu !== 'string' ||
        typeof payload.iat !== 'number' || !Number.isSafeInteger(payload.iat) ||
        typeof payload.code_hash !== 'string' || typeof payload.fingerprint !== 'string' || typeof payload.device_id !== 'string' || !UUID_RE.test(payload.device_id)) {
      throw new UnauthorizedException({ code: 'INVALID_INITIAL_PROOF_CLAIMS', message: 'Initial proof claims are invalid.' });
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - payload.iat) > CLOCK_SKEW_SECONDS) {
      throw new UnauthorizedException({ code: 'INITIAL_PROOF_EXPIRED', message: 'Initial proof timestamp is outside the ±60 second window.' });
    }
    if (payload.htm !== 'POST' || payload.htu !== ENROLLMENT_PATH) {
      throw new UnauthorizedException({ code: 'INITIAL_PROOF_REQUEST_MISMATCH', message: 'Initial proof is not bound to this enrollment endpoint.' });
    }

    const expectedCodeHash = createHash('sha256').update(dto.activationCode, 'utf8').digest('base64url');
    if (payload.code_hash !== expectedCodeHash || payload.fingerprint !== hardwareId || payload.device_id !== dto.deviceId) {
      throw new UnauthorizedException({ code: 'INITIAL_PROOF_BINDING_MISMATCH', message: 'Proof does not match the activation code and device fingerprint.' });
    }

    const signature = decodeCanonicalBase64Url(signatureB64);
    if (signature.length !== SIGNATURE_BYTES) {
      throw new UnauthorizedException({ code: 'INVALID_INITIAL_PROOF_SIGNATURE_LENGTH', message: 'ES256 signature must be exactly 64 IEEE P1363 bytes.' });
    }
    const valid = verify('sha256', Buffer.from(headerB64 + '.' + payloadB64, 'ascii'),
      { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
    if (!valid) throw new UnauthorizedException({ code: 'INVALID_INITIAL_PROOF_SIGNATURE', message: 'Proof of possession failed.' });

    const jwk = publicKey.export({ format: 'jwk' });
    const canonicalJwk = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
    return createHash('sha256').update(canonicalJwk, 'utf8').digest('base64url');
  }

  async enrollDevice(dto: EnrollDeviceDto, hardwareId: string, tenantId: string) {
    if (typeof hardwareId !== 'string' || !hardwareId.trim() || hardwareId.length > 255) {
      throw new BadRequestException('En-tête X-Device-Fingerprint requis (1 à 255 caractères).');
    }
    if (!UUID_RE.test(tenantId ?? '')) throw new UnauthorizedException('Contexte tenant JWT manquant ou invalide.');

    // Verify possession before opening a transaction or writing anything.
    const keyThumbprint = this.verifyInitialProof(dto, hardwareId.trim());
    const codeHash = createHash('sha256').update(dto.activationCode, 'utf8').digest('hex');

    try {
      return await this.db.transaction(async (tx) => {
        const result = await tx.execute(sql`
          SELECT *
          FROM public.register_device_enrollment_with_credential(
            ${codeHash}, ${tenantId}::uuid, ${dto.deviceId}::uuid,
            ${dto.deviceName}::varchar, ${hardwareId.trim()}::varchar,
            ${JSON.stringify(dto.hardwareInfo)}::jsonb,
            ${dto.publicKeyPem}::text, ${keyThumbprint}::varchar
          )
        `);
        const device = result.rows[0] as {
          result_device_id: string; result_tenant_id: string; result_store_id: string; result_pos_profile_id: string | null;
          result_device_name: string; result_approval_status: string; result_key_thumbprint: string;
        } | undefined;
        if (!device) throw new BadRequestException("Code d'activation invalide, expiré ou déjà utilisé.");

        return {
          success: true,
          data: {
            deviceId: device.result_device_id, tenantId: device.result_tenant_id,
            store: { id: device.result_store_id }, posProfileId: device.result_pos_profile_id,
            deviceName: device.result_device_name, approvalStatus: device.result_approval_status,
            keyThumbprint: device.result_key_thumbprint,
          },
        };
      });
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof UnauthorizedException) throw error;
      let current: unknown = error;
      const seen = new Set<unknown>();
      while (current && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        const candidate = current as { code?: unknown; cause?: unknown };
        if (candidate.code === '23505') throw new ConflictException('Ce poste est déjà enrôlé pour ce tenant.');
        if (candidate.code === '28000') {
          throw new BadRequestException({ code: 'INVALID_OR_USED_PAIRING_CODE', message: "Code d'activation invalide, expiré, déjà utilisé ou associé à un autre tenant." });
        }
        current = candidate.cause;
      }
      throw error;
    }
  }

  async getDeviceStatus(tenantId: string, deviceId: string) {
    if (!UUID_RE.test(tenantId ?? '') || !UUID_RE.test(deviceId ?? '')) throw new BadRequestException('Identité du terminal invalide.');
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
      const result = await tx.execute(sql`
        SELECT id, tenant_id, approval_status, is_active
        FROM public.devices
        WHERE tenant_id = ${tenantId}::uuid AND id = ${deviceId}::uuid
        LIMIT 1
      `);
      const row = result.rows[0] as { id: string; tenant_id: string; approval_status: string; is_active: boolean } | undefined;
      if (!row) throw new ForbiddenException({ code: 'DEVICE_NOT_FOUND', message: 'Terminal introuvable pour ce tenant.' });
      return { deviceId: row.id, tenantId: row.tenant_id, approvalStatus: row.approval_status, isActive: row.is_active };
    });
  }
}
