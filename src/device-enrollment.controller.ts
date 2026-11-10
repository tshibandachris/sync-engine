import {
  Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DeviceEnrollmentService } from './device-enrollment.service.js';
import { parseEnrollDeviceDto } from './device-enrollment.dto.js';
import { JwtAuthGuard } from './jwt.guard.js';

interface AuthenticatedRequest extends Request { tenantId: string; }

@Controller('api/v1/devices')
export class DeviceEnrollmentController {
  constructor(private readonly enrollment: DeviceEnrollmentService) {}

  @Post('enroll')
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @HttpCode(HttpStatus.CREATED)
  async enrollDevice(
    @Body() body: unknown,
    @Headers('x-device-fingerprint') hardwareId: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const dto = parseEnrollDeviceDto(body);
    return this.enrollment.enrollDevice(dto, hardwareId ?? '', request.tenantId);
  }

  @Get('status')
  @UseGuards(JwtAuthGuard)
  async getStatus(
    @Headers('x-device-id') deviceId: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.enrollment.getDeviceStatus(request.tenantId, deviceId ?? '');
  }
}
