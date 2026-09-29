import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AgentGuard } from './agent.guard.js';
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
@UseGuards(AgentGuard)
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
      lastPulledAt: body?.last_pulled_at ?? null,
      limit: body?.limit,
    });
  }

  @Post('push')
  async pushEndpoint(@Req() req: any, @Body() body: SyncPushDto) {
    if (!body || !body.changes) throw new BadRequestException('changes requis.');
    const raw = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(raw) ? raw[0] : raw;
    return this.push.pushChanges(req.agentId, body, idempotencyKey);
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
      resolution: body.resolution,
      resolvedBy: body.resolved_by,
    });
    return { status: 'ok' };
  }
}