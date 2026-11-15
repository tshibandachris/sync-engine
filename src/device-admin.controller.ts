import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
  SetMetadata,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt.guard.js';
import {
  DEVICE_ADMIN_PERMISSION,
  DeviceAdminPermissionGuard,
} from './device-admin.guard.js';
import { DeviceAdminService } from './device-admin.service.js';

interface AdminRequest {
  tenantId: string;
  agentId: string;
}

@Controller('api/v1/admin/devices')
@UseGuards(JwtAuthGuard, DeviceAdminPermissionGuard)
export class DeviceAdminController {
  constructor(private readonly devices: DeviceAdminService) {}

  @Get('pending')
  @SetMetadata(DEVICE_ADMIN_PERMISSION, 'devices:read')
  listPending(@Req() req: AdminRequest) {
    return this.devices.listPending(req.tenantId);
  }

  @Post(':id/approve')
  @SetMetadata(DEVICE_ADMIN_PERMISSION, 'devices:approve')
  approve(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.devices.transition({
      tenantId: req.tenantId,
      deviceId: id,
      actorId: req.agentId,
      action: 'approve',
    });
  }

  @Post(':id/reject')
  @SetMetadata(DEVICE_ADMIN_PERMISSION, 'devices:reject')
  reject(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    if (body?.reason !== undefined && typeof body.reason !== 'string') {
      throw new BadRequestException('reason doit être une chaîne.');
    }
    return this.devices.transition({
      tenantId: req.tenantId,
      deviceId: id,
      actorId: req.agentId,
      action: 'reject',
      reason: body?.reason,
    });
  }

  @Post(':id/revoke')
  @SetMetadata(DEVICE_ADMIN_PERMISSION, 'devices:revoke')
  revoke(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    if (body?.reason !== undefined && typeof body.reason !== 'string') {
      throw new BadRequestException('reason doit être une chaîne.');
    }
    return this.devices.transition({
      tenantId: req.tenantId,
      deviceId: id,
      actorId: req.agentId,
      action: 'revoke',
      reason: body?.reason,
    });
  }
}
