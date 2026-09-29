import { BadRequestException, Body, Controller, ForbiddenException, Inject, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000000';

interface TokenDto {
  agent_id?: string;
  tenant_id?: string;
}

@Controller('auth')
export class AuthController {
  private readonly allowDevToken: boolean;

  constructor(@Inject(JwtService) private readonly jwtService: JwtService) {
    this.allowDevToken = process.env.AUTH_ALLOW_DEV_TOKEN === 'true';
  }

  @Post('token')
  async generateToken(@Body() body: TokenDto) {
    if (!this.allowDevToken) {
      throw new ForbiddenException('Delivrance de token desactivee. Configurez un IdP.');
    }

    const agentId = body?.agent_id?.trim();
    if (!agentId || !UUID_RE.test(agentId)) {
      throw new BadRequestException('agent_id UUID requis.');
    }

    const tenantId = (body?.tenant_id ?? DEFAULT_TENANT_ID).trim();
    if (!UUID_RE.test(tenantId)) {
      throw new BadRequestException('tenant_id UUID requis.');
    }

    const token = await this.jwtService.signAsync({ sub: agentId, tenantId });

    return {
      token,
      expires_in: 30 * 24 * 3600,
      agent_id: agentId,
      tenant_id: tenantId,
    };
  }
}