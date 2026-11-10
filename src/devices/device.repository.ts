import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../schema.js';

export interface DeviceWithCredential {
  id: string;
  tenantId: string;
  name: string;
  approvalStatus: 'pending_approval' | 'approved' | 'rejected' | 'revoked';
  isActive: boolean;
  publicKeyPem: string | null;
  credentialStatus: 'active' | null;
  algorithm: 'ES256' | null;
}

/**
 * Loads the device independently of credential presence. The LEFT JOIN is
 * intentional: a registered but unapproved device must remain distinguishable
 * from an unknown device and from an approved device missing its credential.
 */
@Injectable()
export class DeviceRepository {
  constructor(
    @Inject('DRIZZLE_DB')
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async findDeviceWithActiveCredential(
    tenantId: string,
    deviceId: string,
  ): Promise<DeviceWithCredential | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT set_config('app.current_tenant_id', ${tenantId}, true)
      `);

      const result = await tx.execute(sql`
        SELECT
          d.id,
          d.tenant_id AS "tenantId",
          d.name,
          d.approval_status AS "approvalStatus",
          d.is_active AS "isActive",
          c.public_key_pem AS "publicKeyPem",
          c.status AS "credentialStatus",
          c.algorithm AS "algorithm"
        FROM public.devices d
        LEFT JOIN public.device_credentials c
          ON c.tenant_id = d.tenant_id
         AND c.device_id = d.id
         AND c.status = 'active'
        WHERE d.tenant_id = ${tenantId}::uuid
          AND d.id = ${deviceId}::uuid
        LIMIT 1
      `);

      if (result.rows.length === 0) return null;
      return result.rows[0] as unknown as DeviceWithCredential;
    });
  }
}
