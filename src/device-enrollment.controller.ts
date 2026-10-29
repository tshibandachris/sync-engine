import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DeviceEnrollmentService } from './device-enrollment.service.js';
import { parseEnrollDeviceDto } from './device-enrollment.dto.js';

@Controller('api/v1/devices')
export class DeviceEnrollmentController {
  constructor(private readonly enrollment: DeviceEnrollmentService) {}

  @Post('enroll')
  @UseGuards(ThrottlerGuard)
  @HttpCode(HttpStatus.CREATED)
  async enrollDevice(
    @Body() body: unknown,
    @Headers('x-device-fingerprint') hardwareId: string | undefined,
  ) {
    const dto = parseEnrollDeviceDto(body);
    return this.enrollment.enrollDevice(dto, hardwareId ?? '');
  }
}
