import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../schema.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Shared PostgreSQL replay registry.
 *
 * The tenant context is transaction-local, so pooled connections cannot leak
 * one request's tenant into another. The primary key arbitrates concurrent
 * attempts across every API instance.
 */
@Injectable()
export class DeviceProofNonceRepository {
  constructor(
    @Inject('DRIZZLE_DB')
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async recordNonceIfUnseen(
    tenantId: string,
    deviceId: string,
    jti: string,
    expiresAt: Date,
  ): Promise<boolean> {
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(deviceId) || !UUID_RE.test(jti)) {
      throw new TypeError('tenantId, deviceId and jti must be valid UUIDs');
    }
    if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) {
      throw new TypeError('expiresAt must be a valid Date');
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT set_config('app.current_tenant_id', ${tenantId}, true)
      `);

      const result = await tx.execute(sql`
        INSERT INTO public.device_proof_nonces (
          tenant_id, device_id, jti, expires_at
        )
        VALUES (
          ${tenantId}::uuid,
          ${deviceId}::uuid,
          ${jti}::uuid,
          ${expiresAt.toISOString()}::timestamptz
        )
        ON CONFLICT (tenant_id, device_id, jti) DO NOTHING
        RETURNING jti
      `);

      return result.rows.length === 1;
    });
  }
}
