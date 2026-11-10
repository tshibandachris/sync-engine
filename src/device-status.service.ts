import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

type DeviceStatusRow = {
  id: string;
  tenant_id: string;
  name: string;
  approval_status: 'pending_approval' | 'approved' | 'rejected' | 'revoked';
  is_active: boolean;
  has_active_credential: boolean;
};

@Injectable()
export class DeviceStatusService {
  constructor(
    @Inject('DRIZZLE_DB')
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async getStatus(tenantId: string, deviceId: string) {
    const rows = await this.db.transaction(async (tx) => {
      // The controller bypasses DeviceApprovalGuard so a terminal can learn
      // pending/rejected/revoked/deactivated state. DeviceProofGuard still
      // verifies possession of that terminal's latest key before this query.
      // JWT tenant identity and PostgreSQL RLS remain mandatory.
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
      const result = await tx.execute(sql`
        SELECT
          d.id,
          d.tenant_id,
          d.name,
          d.approval_status,
          d.is_active,
          EXISTS (
            SELECT 1
            FROM public.device_credentials AS c
            WHERE c.tenant_id = d.tenant_id
              AND c.device_id = d.id
              AND c.status = 'active'
          ) AS has_active_credential
        FROM public.devices AS d
        WHERE d.tenant_id = ${tenantId}::uuid
          AND d.id = ${deviceId}::uuid
        LIMIT 1
      `);
      return result.rows as DeviceStatusRow[];
    });

    const device = rows[0];
    if (!device) return null;

    return {
      deviceId: device.id,
      tenantId: device.tenant_id,
      name: device.name,
      approvalStatus: device.approval_status,
      isActive: device.is_active,
      hasActiveCredential: device.has_active_credential,
      serverTime: new Date().toISOString(),
    };
  }
}
