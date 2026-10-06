import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { readIdpConfig, type IdpConfig } from './idp.config.js';
import { IdpVerificationError, verifyToken } from './idp-token.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verifies the bearer token on every request.
 *
 * Two strategies, chosen once at boot by readIdpConfig:
 *
 *   - JWKS mode (JWKS_URL set): the token is signed by an external identity
 *     provider. We fetch their public keys from the JWKS endpoint and
 *     validate signature, expiry, audience, and issuer. The agent and tenant
 *     are read from the configured claims.
 *
 *   - dev-secret mode (JWKS_URL empty, non-production): the token is signed
 *     locally with JWT_SECRET. Used by /auth/token and by the test suite.
 *     The boot guards refuse to start in production without JWKS_URL.
 *
 * Either way, request.agentId and request.tenantId are set to validated
 * UUIDs. Services never see a request that reached them without both.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly config: IdpConfig;
  private readonly jwks?: JWTVerifyGetKey;

  constructor(@Inject(JwtService) private readonly jwt: JwtService) {
    this.config = readIdpConfig();

    if (this.config.mode === 'jwks' && this.config.jwksUrl) {
      // Fails fast at construction if the URL is malformed.
      this.jwks = createRemoteJWKSet(new URL(this.config.jwksUrl));
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = request.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;

    if (!raw || typeof raw !== 'string' || !raw.startsWith('Bearer ')) {
      throw new UnauthorizedException('Header Authorization manquant ou invalide.');
    }

    const token = raw.slice('Bearer '.length).trim();

    try {
      if (this.config.mode === 'jwks' && this.jwks) {
        const id = await verifyToken(token, this.jwks, {
          audience: this.config.audience,
          issuer: this.config.issuer,
          tenantClaim: this.config.tenantClaim,
        });
        request.agentId = id.agentId;
        request.tenantId = id.tenantId;
        return true;
      }

      // dev-secret mode
      const payload = await this.jwt.verifyAsync<{ sub: string; tenantId: string }>(token);

      if (!payload.sub || !UUID_RE.test(payload.sub)) {
        throw new UnauthorizedException('Payload JWT invalide : sub manquant.');
      }
      if (!payload.tenantId || !UUID_RE.test(payload.tenantId)) {
        throw new UnauthorizedException('Payload JWT invalide : tenantId manquant.');
      }

      request.agentId = payload.sub;
      request.tenantId = payload.tenantId;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      if (err instanceof IdpVerificationError) {
        throw new UnauthorizedException(err.message);
      }
      throw new UnauthorizedException('Token invalide ou expire.');
    }
  }
}
