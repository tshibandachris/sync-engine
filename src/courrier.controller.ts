import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt.guard.js';
import {
  CourrierService,
  type CourrierActor,
  type CreateCourrierDto,
  type RequestCourrierAttachmentDto,
} from './courrier.service.js';

interface AuthenticatedRequest {
  agentId: string;
  tenantId: string;
  permissions?: string[];
  serviceIds?: string[];
}

function actorFromRequest(req: AuthenticatedRequest): CourrierActor {
  return {
    agentId: req.agentId,
    tenantId: req.tenantId,
    permissions: req.permissions ?? [],
    serviceIds: req.serviceIds ?? [],
  };
}

@Controller('courriers')
@UseGuards(JwtAuthGuard)
export class CourrierController {
  constructor(@Inject(CourrierService) private readonly courriers: CourrierService) {}

  @Post()
  create(@Req() req: AuthenticatedRequest, @Body() body: CreateCourrierDto) {
    return this.courriers.create(actorFromRequest(req), body);
  }

  @Get()
  list(@Req() req: AuthenticatedRequest, @Query('limit') limit?: string) {
    let parsed: number | undefined;
    if (limit !== undefined) {
      parsed = Number(limit);
      if (!Number.isInteger(parsed)) throw new BadRequestException('limit doit être un entier.');
    }
    return this.courriers.list(actorFromRequest(req), parsed);
  }

  @Get(':id')
  get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.courriers.get(actorFromRequest(req), id);
  }

  @Post(':id/assignments')
  assign(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { agent_id?: string; service_id?: string; agentId?: string; serviceId?: string },
  ) {
    return this.courriers.assign(actorFromRequest(req), id, {
      agentId: body?.agentId ?? body?.agent_id,
      serviceId: body?.serviceId ?? body?.service_id,
    });
  }

  @Get(':id/assignments')
  listAssignments(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.courriers.listAssignments(actorFromRequest(req), id);
  }

  @Post(':id/assignments/:assignmentId/revoke')
  revokeAssignment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
  ) {
    return this.courriers.revokeAssignment(actorFromRequest(req), id, assignmentId);
  }

  @Post(':id/transitions')
  transition(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { to_status?: string; toStatus?: string },
  ) {
    return this.courriers.transition(actorFromRequest(req), id, body?.toStatus ?? body?.to_status);
  }

  @Get(':id/audit')
  audit(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    let parsed: number | undefined;
    if (limit !== undefined) {
      parsed = Number(limit);
      if (!Number.isInteger(parsed)) throw new BadRequestException('limit doit être un entier.');
    }
    return this.courriers.listAudit(actorFromRequest(req), id, parsed);
  }

  @Post(':id/attachments/request-upload')
  requestAttachment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: RequestCourrierAttachmentDto,
  ) {
    return this.courriers.requestAttachment(actorFromRequest(req), id, {
      contentType: body?.contentType ?? (body as any)?.content_type,
      sizeBytes: body?.sizeBytes ?? (body as any)?.size_bytes,
      checksumSha256: body?.checksumSha256 ?? (body as any)?.checksum_sha256,
    });
  }

  @Post(':id/attachments/:attachmentId/confirm')
  confirmAttachment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.courriers.confirmAttachment(actorFromRequest(req), id, attachmentId);
  }

  @Get(':id/attachments')
  listAttachments(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.courriers.listAttachments(actorFromRequest(req), id);
  }
}
