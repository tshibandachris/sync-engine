import { BadRequestException, Body, Controller, ForbiddenException, Inject, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TokenDto {
  agent_id?: string;
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

    const raw = body?.agent_id;
    if (!raw || typeof raw !== 'string' || !UUID_RE.test(raw.trim())) {
      throw new BadRequestException('agent_id UUID requis.');
    }

    const agentId = raw.trim();
    const token = await this.jwtService.signAsync({ sub: agentId });

    return {
      token,
      expires_in: 30 * 24 * 3600,
      agent_id: agentId,
    };
  }
}