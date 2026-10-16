import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from './jwt.guard.js';
import { CashSessionService, type CloseCashSessionDto } from './cash-session.service.js';

@Controller('cash-sessions')
@UseGuards(JwtAuthGuard)
export class CashSessionController {
  constructor(private readonly sessions: CashSessionService) {}

  @Post(':id/close')
  async close(@Req() req: any, @Param('id') id: string, @Body() body: CloseCashSessionDto) {
    return this.sessions.closeSession(id, req.tenantId, body);
  }
}
