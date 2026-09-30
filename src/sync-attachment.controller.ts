import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from './jwt.guard.js';
import { AttachmentService } from './sync-attachment.service.js';

interface RequestUploadBody {
  check_in_id?: string;
  content_type?: string;
  size_bytes?: number;
  checksum_sha256?: string;
}

@Controller('attachments')
@UseGuards(JwtAuthGuard)
export class AttachmentController {
  constructor(
    @Inject(AttachmentService) private readonly svc: AttachmentService,
  ) {}

  @Post('request-upload')
  async requestUpload(@Req() req: any, @Body() body: RequestUploadBody) {
    if (!body?.check_in_id || !body?.content_type || typeof body?.size_bytes !== 'number' || !body?.checksum_sha256) {
      throw new BadRequestException('check_in_id, content_type, size_bytes, checksum_sha256 requis.');
    }
    return this.svc.requestUpload({
      tenantId: req.tenantId,
      agentId: req.agentId,
      checkInId: body.check_in_id,
      contentType: body.content_type,
      sizeBytes: body.size_bytes,
      checksumSha256: body.checksum_sha256,
    });
  }

  @Post(':id/confirm')
  async confirm(@Req() req: any, @Param('id') id: string) {
    return this.svc.confirmUpload({
      tenantId: req.tenantId,
      agentId: req.agentId,
      attachmentId: id,
    });
  }

  @Get()
  async list(@Req() req: any, @Query('check_in_id') checkInId?: string) {
    if (!checkInId) throw new BadRequestException('check_in_id requis.');
    return this.svc.listForCheckIn({
      tenantId: req.tenantId,
      agentId: req.agentId,
      checkInId,
    });
  }
}
