import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  UnauthorizedException,
  UseGuards,
  Req,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt.guard.js';
import { DeviceStatusService } from './device-status.service.js';
import { DeviceProofGuard } from './auth/device-proof.guard.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('api/v1/devices')
@UseGuards(JwtAuthGuard, DeviceProofGuard)
export class DeviceStatusController {
  constructor(private readonly status: DeviceStatusService) {}

  @Get('status')
  async getStatus(
    @Headers('x-device-id') rawDeviceId: string | undefined,
    @Req() request: { tenantId?: string },
  ) {
    const deviceId = typeof rawDeviceId === 'string' ? rawDeviceId.trim() : '';
    const tenantId = request.tenantId;

    if (!deviceId) {
      throw new UnauthorizedException({
        code: 'DEVICE_IDENTITY_MISSING',
        message: 'X-Device-Id header is required to check device status.',
      });
    }
    if (!UUID_RE.test(deviceId) || !UUID_RE.test(tenantId ?? '')) {
      throw new UnauthorizedException({
        code: 'DEVICE_IDENTITY_INVALID',
        message: 'Device or tenant identity is invalid.',
      });
    }

    const result = await this.status.getStatus(tenantId!, deviceId);
    if (!result) {
      throw new NotFoundException({
        code: 'DEVICE_NOT_FOUND',
        message: 'Device is not registered for this tenant.',
      });
    }
    return result;
  }
}
