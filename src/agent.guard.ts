import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AgentGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header = request.headers['x-agent-id'];
    const agentId = Array.isArray(header) ? header[0] : header;

    if (!agentId || typeof agentId !== 'string' || !UUID_RE.test(agentId)) {
      throw new UnauthorizedException('Header x-agent-id manquant ou invalide.');
    }

    request.agentId = agentId;
    return true;
  }
}