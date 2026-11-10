import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class DeviceApprovalGuard implements CanActivate {
  constructor(
    @Inject('DRIZZLE_DB')
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const tenantId = request.tenantId;
    const rawDeviceId = request.headers['x-device-id'];
    const deviceId = Array.isArray(rawDeviceId) ? rawDeviceId[0] : rawDeviceId;

    if (typeof deviceId !== 'string' || !deviceId.trim()) {
      throw new UnauthorizedException({
        code: 'DEVICE_IDENTITY_MISSING',
        message: 'X-Device-Id header is required for synchronization',
      });
    }
    if (!UUID_RE.test(deviceId) || !UUID_RE.test(tenantId ?? '')) {
      throw new UnauthorizedException({
        code: 'DEVICE_IDENTITY_INVALID',
        message: 'Device or tenant identity is invalid',
      });
    }

    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
      const result = await tx.execute(sql`
        SELECT id, tenant_id, is_active, approval_status
        FROM public.devices
        WHERE tenant_id = ${tenantId}::uuid AND id = ${deviceId}::uuid
        LIMIT 1
      `);
      return result.rows as Array<{
        id: string;
        tenant_id: string;
        is_active: boolean;
        approval_status: string;
      }>;
    });

    const device = rows[0];
    if (!device) {
      throw new ForbiddenException({
        code: 'DEVICE_NOT_FOUND',
        message: 'Device is not registered for this tenant',
      });
    }
    if (!device.is_active) {
      throw new ForbiddenException({
        code: 'DEVICE_DEACTIVATED',
        message: 'Device has been disabled',
      });
    }

    switch (device.approval_status) {
      case 'approved':
        request.deviceId = device.id;
        request.device = device;
        return true;
      case 'pending_approval':
        throw new ForbiddenException({
          code: 'DEVICE_PENDING_APPROVAL',
          message: 'Device is waiting for administrator approval',
        });
      case 'rejected':
        throw new ForbiddenException({
          code: 'DEVICE_REJECTED',
          message: 'Device enrollment was rejected',
        });
      case 'revoked':
        throw new ForbiddenException({
          code: 'DEVICE_REVOKED',
          message: 'Device authorization has been revoked',
        });
      default:
        throw new ForbiddenException({
          code: 'DEVICE_UNAUTHORIZED',
          message: 'Device is not authorized to synchronize',
        });
    }
  }
}
