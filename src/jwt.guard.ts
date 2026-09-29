import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = request.headers['authorization'];

    const raw = Array.isArray(header) ? header[0] : header;

    if (!raw || typeof raw !== 'string' || !raw.startsWith('Bearer ')) {
      throw new UnauthorizedException('Header Authorization manquant ou invalide.');
    }

    const token = raw.slice('Bearer '.length).trim();

    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token);
      request.agentId = payload.sub;
      return true;
    } catch {
      throw new UnauthorizedException('Token invalide ou expire.');
    }
  }
}