import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from './jwt.guard.js';
import { SyncPullService } from './sync-pull.service.js';
import { SyncPushService, type SyncPushDto } from './sync-push.service.js';
import { SyncConflictService, type Resolution } from './sync-conflict.service.js';

interface PullBody {
  last_pulled_at?: number | null;
  limit?: number;
}

interface ResolveBody {
  resolution: Resolution;
  resolved_by: string;
}

@Controller('sync')
@UseGuards(JwtAuthGuard)
export class SyncController {
  constructor(
    @Inject(SyncPullService) private readonly pull: SyncPullService,
    @Inject(SyncPushService) private readonly push: SyncPushService,
    @Inject(SyncConflictService) private readonly conflict: SyncConflictService,
  ) {}

  @Post('pull')
  async pullEndpoint(@Req() req: any, @Body() body: PullBody) {
    return this.pull.pullChanges({
      agentId: req.agentId,
      tenantId: req.tenantId,
      lastPulledAt: body?.last_pulled_at ?? null,
      limit: body?.limit,
    });
  }

  @Post('push')
  async pushEndpoint(@Req() req: any, @Body() body: SyncPushDto, @Res({ passthrough: true }) res: any) {
    if (!body || !body.changes) throw new BadRequestException('changes requis.');
    const raw = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(raw) ? raw[0] : raw;
    const result = await this.push.pushChanges(req.agentId, body, idempotencyKey, req.tenantId);
    const onlyCashSessionReplay =
      Array.isArray(body.changes.cash_sessions) &&
      body.changes.cash_sessions.length > 0 &&
      result.cash_sessions?.length === body.changes.cash_sessions.length &&
      result.cash_sessions.every((item) => item.status === 'idempotent') &&
      result.applied.created === 0 && result.applied.updated === 0 && result.applied.deleted === 0 &&
      result.conflicts.length === 0 && !result.products && !result.staff;
    if (onlyCashSessionReplay) res.status(200);
    return result;
  }

  @Get('conflicts')
  async listConflicts(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.conflict.listConflicts({
      agentId: req.agentId,
      tenantId: req.tenantId,
      status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Post('conflicts/:id/resolve')
  async resolveConflict(@Req() req: any, @Param('id') id: string, @Body() body: ResolveBody) {
    if (!body || !body.resolution || !body.resolved_by) {
      throw new BadRequestException('resolution et resolved_by requis.');
    }
    await this.conflict.resolveConflict({
      conflictId: id,
      agentId: req.agentId,
      tenantId: req.tenantId,
      resolution: body.resolution,
      resolvedBy: body.resolved_by,
    });
    return { status: 'ok' };
  }
}