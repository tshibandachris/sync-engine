import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = request.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;

    if (!raw || typeof raw !== 'string' || !raw.startsWith('Bearer ')) {
      throw new UnauthorizedException('Header Authorization manquant ou invalide.');
    }

    const token = raw.slice('Bearer '.length).trim();

    try {
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
      throw new UnauthorizedException('Token invalide ou expire.');
    }
  }
}