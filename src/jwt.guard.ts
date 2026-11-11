import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { readIdpConfig, type IdpConfig } from './idp.config.js';
import { IdpVerificationError, verifyToken } from './idp-token.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verifies bearer tokens. Production JWKS mode accepts asymmetric ES256/RS256
 * signatures only and requires server-controlled agent_id + tenantId claims.
 * Local shared-secret verification remains development-only.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly config: IdpConfig;
  private readonly jwks?: JWTVerifyGetKey;

  constructor(@Inject(JwtService) private readonly jwt: JwtService) {
    this.config = readIdpConfig();
    if (this.config.mode === 'jwks' && this.config.jwksUrl) {
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
        });
        request.agentId = id.agentId;
        request.tenantId = id.tenantId;
        request.permissions = id.permissions;
        request.serviceIds = id.serviceIds;
        request.authMode = 'jwks';
        return true;
      }

      const payload = await this.jwt.verifyAsync<{
        sub: string;
        tenantId: string;
        permissions?: unknown;
        scope?: unknown;
        service_ids?: unknown;
        serviceIds?: unknown;
        token_use?: unknown;
      }>(token);

      if (!payload.sub || !UUID_RE.test(payload.sub)) {
        throw new UnauthorizedException('Payload JWT invalide : sub manquant.');
      }
      if (!payload.tenantId || !UUID_RE.test(payload.tenantId)) {
        throw new UnauthorizedException('Payload JWT invalide : tenantId manquant.');
      }

      request.agentId = payload.sub;
      request.tenantId = payload.tenantId;
      const rawPermissions = payload.permissions;
      request.permissions = Array.isArray(rawPermissions)
        ? rawPermissions.filter((value): value is string => typeof value === 'string')
        : typeof payload.scope === 'string' ? payload.scope.split(/\\s+/).filter(Boolean) : [];
      const rawServiceIds = payload.service_ids ?? payload.serviceIds;
      request.serviceIds = Array.isArray(rawServiceIds)
        ? rawServiceIds.filter((value): value is string => typeof value === 'string' && UUID_RE.test(value))
        : [];
      request.authMode = 'dev-secret';
      request.tokenUse = typeof payload.token_use === 'string' ? payload.token_use : null;
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
