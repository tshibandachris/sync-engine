import {
  BadRequestException,
  ConflictException,
  Injectable,
  Inject,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import type { EnrollDeviceDto } from './device-enrollment.dto.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const CLOCK_SKEW_SECONDS = 60;
const P1363_SIGNATURE_LENGTH = 64;

interface InitialProofPayload {
  jti: string;
  htm: string;
  htu: string;
  iat: number;
  code_hash: string;
  fingerprint: string;
}

function decodeBase64Url(segment: string, code: string): Buffer {
  if (!segment || !BASE64URL_RE.test(segment)) {
    throw new BadRequestException({ code, message: 'Segment base64url invalide.' });
  }
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) {
    throw new BadRequestException({ code, message: 'Encodage base64url non canonique.' });
  }
  return decoded;
}

function parseObject<T extends object>(buffer: Buffer, code: string): T {
  try {
    const value: unknown = JSON.parse(buffer.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
    return value as T;
  } catch {
    throw new BadRequestException({ code, message: 'Objet JSON JWS invalide.' });
  }
}

function exactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

@Injectable()
export class DeviceEnrollmentService {
  constructor(
    @Inject('DRIZZLE_DB')
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async enrollDevice(dto: EnrollDeviceDto, hardwareId: string) {
    if (typeof hardwareId !== 'string' || !hardwareId.trim() || hardwareId.length > 255) {
      throw new BadRequestException('En-tête X-Device-Fingerprint requis (1 à 255 caractères).');
    }
    const fingerprint = hardwareId.trim();
    const key = this.validateP256PublicKey(dto.publicKeyPem);
    const keyThumbprint = this.computeRfc7638Thumbprint(key);
    const codeHashHex = createHash('sha256').update(dto.activationCode, 'utf8').digest('hex');
    const jti = this.verifyInitialProof(dto, fingerprint, key, codeHashHex);

    try {
      const result = await this.db.execute(sql`
        SELECT *
        FROM public.register_device_enrollment_with_credential(
          ${codeHashHex},
          ${randomUUID()}::uuid,
          ${dto.deviceName}::varchar,
          ${fingerprint}::varchar,
          ${JSON.stringify(dto.hardwareInfo)}::jsonb,
          ${dto.publicKeyPem},
          ${keyThumbprint}::varchar,
          ${jti}::uuid
        )
      `);
      const row = result.rows[0] as {
        device_id: string;
        tenant_id: string;
        store_id: string;
        pos_profile_id: string | null;
        device_name: string;
        approval_status: string;
        credential_id: string;
      } | undefined;

      if (!row) throw new Error('Atomic enrollment function returned no row.');
      return {
        success: true,
        data: {
          deviceId: row.device_id,
          tenantId: row.tenant_id,
          store: { id: row.store_id },
          posProfileId: row.pos_profile_id,
          deviceName: row.device_name,
          approvalStatus: row.approval_status,
          credentialId: row.credential_id,
          keyThumbprint,
        },
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof UnauthorizedException) throw error;
      let current: unknown = error;
      const seen = new Set<unknown>();
      while (current && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        const candidate = current as { code?: unknown; cause?: unknown };
        if (candidate.code === 'P1001') {
          throw new UnauthorizedException({
            code: 'INVALID_ACTIVATION_CODE',
            message: "Code d'activation invalide, expiré ou déjà utilisé.",
          });
        }
        if (candidate.code === '23505') {
          throw new ConflictException('Ce terminal ou cette credential est déjà enregistré pour ce tenant.');
        }
        current = candidate.cause;
      }
      throw error;
    }
  }

  private validateP256PublicKey(publicKeyPem: string): ReturnType<typeof createPublicKey> {
    try {
      if (!publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('SPKI required');
      const key = createPublicKey(publicKeyPem);
      if (key.type !== 'public' || key.asymmetricKeyType !== 'ec' ||
          key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error('ES256 P-256 public key required');
      }
      return key;
    } catch {
      throw new BadRequestException({
        code: 'INVALID_PUBLIC_KEY',
        message: 'Une clé publique EC P-256 au format SPKI PEM est requise.',
      });
    }
  }

  private computeRfc7638Thumbprint(publicKey: ReturnType<typeof createPublicKey>): string {
    const jwk = publicKey.export({ format: 'jwk' });
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
      throw new BadRequestException({ code: 'INVALID_PUBLIC_KEY', message: 'La clé publique doit être EC P-256.' });
    }
    const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
    return createHash('sha256').update(canonical, 'utf8').digest('base64url');
  }

  private verifyInitialProof(
    dto: EnrollDeviceDto,
    fingerprint: string,
    publicKey: ReturnType<typeof createPublicKey>,
    codeHashHex: string,
  ): string {
    const segments = dto.initialProof.split('.');
    if (segments.length !== 3) {
      throw new BadRequestException({ code: 'MALFORMED_INITIAL_PROOF', message: 'JWS compact à trois segments requis.' });
    }
    const [headerB64, payloadB64, signatureB64] = segments;
    const header = parseObject<{ alg?: string; typ?: string }>(
      decodeBase64Url(headerB64, 'INVALID_PROOF_HEADER'),
      'INVALID_PROOF_HEADER',
    );
    if (!exactKeys(header, ['alg', 'typ']) || header.alg !== 'ES256' || header.typ !== 'dpop+jwt') {
      throw new BadRequestException({ code: 'UNSUPPORTED_ALGORITHM', message: 'En-tête ES256 / dpop+jwt requis.' });
    }

    const payload = parseObject<InitialProofPayload>(
      decodeBase64Url(payloadB64, 'INVALID_PROOF_PAYLOAD'),
      'INVALID_PROOF_PAYLOAD',
    );
    if (!exactKeys(payload, ['jti', 'htm', 'htu', 'iat', 'code_hash', 'fingerprint'])) {
      throw new BadRequestException({ code: 'INVALID_PROOF_CLAIMS', message: 'Claims initialProof incomplets ou supplémentaires.' });
    }
    if (typeof payload.jti !== 'string' || !UUID_RE.test(payload.jti)) {
      throw new BadRequestException({ code: 'INVALID_PROOF_JTI', message: 'jti doit être un UUID.' });
    }
    if (payload.htm !== 'POST' || payload.htu !== '/api/v1/devices/enroll') {
      throw new UnauthorizedException({ code: 'INITIAL_PROOF_HTM_HTU_MISMATCH', message: 'Méthode ou chemin de preuve incorrect.' });
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.iat !== 'number' || !Number.isSafeInteger(payload.iat) ||
        Math.abs(now - payload.iat) > CLOCK_SKEW_SECONDS) {
      throw new UnauthorizedException({ code: 'INITIAL_PROOF_EXPIRED', message: 'Horodatage hors fenêtre ±60 secondes.' });
    }
    const expectedCodeHash = createHash('sha256').update(dto.activationCode, 'utf8').digest('base64url');
    if (payload.code_hash !== expectedCodeHash || payload.fingerprint !== fingerprint) {
      throw new UnauthorizedException({ code: 'PROOF_BINDING_MISMATCH', message: 'La preuve ne correspond pas au code ou au terminal.' });
    }

    const signature = decodeBase64Url(signatureB64, 'INVALID_INITIAL_PROOF_SIGNATURE');
    if (signature.length !== P1363_SIGNATURE_LENGTH) {
      throw new BadRequestException({ code: 'INVALID_SIGNATURE_LENGTH', message: 'Signature ES256 P1363 de 64 octets requise.' });
    }
    const valid = verifySignature(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`, 'ascii'),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature,
    );
    if (!valid) {
      throw new UnauthorizedException({
        code: 'INVALID_INITIAL_PROOF_SIGNATURE',
        message: 'La clé privée ne correspond pas à la clé publique fournie.',
      });
    }
    return payload.jti;
  }
}
