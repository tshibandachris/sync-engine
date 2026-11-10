import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'node:crypto';
import { DeviceRepository } from '../devices/device.repository.js';
import { DeviceProofNonceRepository } from './device-proof-nonce.repository.js';

const MAX_CLOCK_SKEW_SECONDS = 60;
const P1363_SIGNATURE_LENGTH_BYTES = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

interface DeviceProofHeader {
  alg: string;
  typ: string;
}

interface DeviceProofPayload {
  jti: string;
  htm: string;
  htu: string;
  iat: number;
  ath: string;
}

function decodeCanonicalBase64Url(segment: string, code: string): Buffer {
  if (!segment || !BASE64URL_RE.test(segment)) {
    throw new UnauthorizedException({ code, message: 'Invalid base64url segment' });
  }

  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) {
    throw new UnauthorizedException({ code, message: 'Non-canonical base64url segment' });
  }
  return decoded;
}

function parseJsonObject<T extends object>(buffer: Buffer, code: string): T {
  try {
    const value: unknown = JSON.parse(buffer.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('JSON value must be an object');
    }
    return value as T;
  } catch {
    throw new UnauthorizedException({ code, message: 'JWS segment must contain a JSON object' });
  }
}

function hasExactKeys(value: object, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

@Injectable()
export class DeviceProofGuard implements CanActivate {
  constructor(
    private readonly deviceRepo: DeviceRepository,
    private readonly nonceRepo: DeviceProofNonceRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const tenantId: unknown = request.tenantId;
    const agentId: unknown = request.agentId;
    const rawAuthorization = request.headers['authorization'];
    const authorization = Array.isArray(rawAuthorization) ? rawAuthorization[0] : rawAuthorization;
    const rawDeviceId = request.headers['x-device-id'];
    const deviceId = Array.isArray(rawDeviceId) ? rawDeviceId[0] : rawDeviceId;
    const rawProof = request.headers['x-device-proof'];
    const proofHeader = Array.isArray(rawProof) ? rawProof[0] : rawProof;

    if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId) ||
        typeof agentId !== 'string' || !UUID_RE.test(agentId)) {
      throw new UnauthorizedException({
        code: 'AUTH_CONTEXT_MISSING',
        message: 'Validated agent and tenant context is required',
      });
    }

    if (typeof deviceId !== 'string' || !deviceId.trim()) {
      throw new UnauthorizedException({
        code: 'DEVICE_IDENTITY_MISSING',
        message: 'X-Device-Id header is required',
      });
    }
    if (!UUID_RE.test(deviceId)) {
      throw new UnauthorizedException({
        code: 'DEVICE_IDENTITY_INVALID',
        message: 'X-Device-Id must be a UUID',
      });
    }
    if (typeof proofHeader !== 'string' || !proofHeader) {
      throw new UnauthorizedException({
        code: 'DEVICE_PROOF_MISSING',
        message: 'X-Device-Proof header is required',
      });
    }

    const bearerMatch = typeof authorization === 'string'
      ? /^Bearer ([^\s]+)$/.exec(authorization)
      : null;
    if (!bearerMatch) {
      throw new UnauthorizedException({
        code: 'TOKEN_MISSING',
        message: 'A single Bearer access token is required',
      });
    }
    const rawJwt = bearerMatch[1];

    const device = await this.deviceRepo.findDeviceWithActiveCredential(tenantId, deviceId);
    if (!device) {
      throw new ForbiddenException({ code: 'DEVICE_NOT_FOUND', message: 'Unknown device for tenant' });
    }
    if (!device.isActive) {
      throw new ForbiddenException({ code: 'DEVICE_DEACTIVATED', message: 'Device has been disabled' });
    }

    switch (device.approvalStatus) {
      case 'pending_approval':
        throw new ForbiddenException({ code: 'DEVICE_PENDING_APPROVAL', message: 'Device is awaiting approval' });
      case 'rejected':
        throw new ForbiddenException({ code: 'DEVICE_REJECTED', message: 'Device enrollment was rejected' });
      case 'revoked':
        throw new ForbiddenException({ code: 'DEVICE_REVOKED', message: 'Device authorization was revoked' });
      case 'approved':
        break;
      default:
        throw new ForbiddenException({ code: 'DEVICE_UNAUTHORIZED', message: 'Device is not approved' });
    }

    if (!device.publicKeyPem || device.credentialStatus !== 'active' || device.algorithm !== 'ES256') {
      throw new ForbiddenException({
        code: 'NO_ACTIVE_CREDENTIAL',
        message: 'Approved device has no active ES256 credential',
      });
    }

    if (proofHeader.length > 8192) {
      throw new UnauthorizedException({ code: 'PROOF_TOO_LARGE', message: 'Device proof exceeds the 8 KiB limit' });
    }

    const segments = proofHeader.split('.');
    if (segments.length !== 3) {
      throw new UnauthorizedException({
        code: 'MALFORMED_PROOF',
        message: 'Proof must be a compact JWS with exactly three segments',
      });
    }
    const [headerB64, payloadB64, signatureB64] = segments;
    const header = parseJsonObject<DeviceProofHeader>(
      decodeCanonicalBase64Url(headerB64, 'INVALID_HEADER'),
      'INVALID_HEADER',
    );
    if (!hasExactKeys(header, ['alg', 'typ']) || header.alg !== 'ES256' || header.typ !== 'dpop+jwt') {
      throw new UnauthorizedException({
        code: 'UNSUPPORTED_PROOF_ALGORITHM',
        message: 'Only the ES256 dpop+jwt protected header is accepted',
      });
    }

    const payload = parseJsonObject<DeviceProofPayload>(
      decodeCanonicalBase64Url(payloadB64, 'INVALID_PAYLOAD'),
      'INVALID_PAYLOAD',
    );
    if (!hasExactKeys(payload, ['jti', 'htm', 'htu', 'iat', 'ath'])) {
      throw new UnauthorizedException({
        code: 'INVALID_PAYLOAD_CLAIMS',
        message: 'Proof payload must contain exactly jti, htm, htu, iat and ath',
      });
    }
    if (typeof payload.jti !== 'string' || !UUID_RE.test(payload.jti)) {
      throw new UnauthorizedException({ code: 'INVALID_JTI', message: 'jti must be a UUID' });
    }
    if (typeof payload.iat !== 'number' || !Number.isSafeInteger(payload.iat)) {
      throw new UnauthorizedException({ code: 'INVALID_IAT', message: 'iat must be an integer Unix timestamp' });
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - payload.iat) > MAX_CLOCK_SKEW_SECONDS) {
      throw new UnauthorizedException({
        code: 'PROOF_EXPIRED',
        message: 'Proof timestamp is outside the allowed ±60 second window',
      });
    }

    const method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
    const originalUrl = typeof request.originalUrl === 'string' ? request.originalUrl : '';
    const canonicalPath = originalUrl.split('?', 1)[0];
    if (!canonicalPath.startsWith('/') || canonicalPath.includes('#') ||
        typeof payload.htm !== 'string' || payload.htm !== method ||
        typeof payload.htu !== 'string' || payload.htu !== canonicalPath) {
      throw new ForbiddenException({
        code: 'HTM_HTU_MISMATCH',
        message: 'Proof method and canonical request path do not match',
      });
    }

    const expectedAth = crypto.createHash('sha256').update(rawJwt, 'utf8').digest('base64url');
    if (typeof payload.ath !== 'string' || payload.ath !== expectedAth) {
      throw new ForbiddenException({
        code: 'ATH_MISMATCH',
        message: 'Proof is not bound to the supplied Bearer token',
      });
    }

    const signature = decodeCanonicalBase64Url(signatureB64, 'INVALID_SIGNATURE_ENCODING');
    if (signature.length !== P1363_SIGNATURE_LENGTH_BYTES) {
      throw new UnauthorizedException({
        code: 'INVALID_SIGNATURE_LENGTH',
        message: 'ES256 signature must be exactly 64 bytes in IEEE P1363 format',
      });
    }

    // Verify the key proof before touching the replay registry. Invalid proofs
    // therefore cannot burn a legitimate jti or create a replay-DoS primitive.
    let signatureValid = false;
    try {
      signatureValid = crypto.verify(
        'sha256',
        Buffer.from(`${headerB64}.${payloadB64}`, 'ascii'),
        { key: device.publicKeyPem, dsaEncoding: 'ieee-p1363' },
        signature,
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      throw new UnauthorizedException({
        code: 'INVALID_DEVICE_SIGNATURE',
        message: 'Cryptographic proof verification failed',
      });
    }

    const expiresAt = new Date((payload.iat + MAX_CLOCK_SKEW_SECONDS) * 1000);
    const recorded = await this.nonceRepo.recordNonceIfUnseen(
      tenantId,
      deviceId,
      payload.jti,
      expiresAt,
    );
    if (!recorded) {
      throw new UnauthorizedException({
        code: 'PROOF_REPLAYED',
        message: 'Proof jti has already been consumed',
      });
    }

    request.deviceId = device.id;
    request.device = device;
    return true;
  }
}
