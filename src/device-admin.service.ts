import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { withTenant } from './with-tenant.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeviceApprovalAction = 'approve' | 'reject' | 'revoke';

@Injectable()
export class DeviceAdminService {
  constructor(
    @Inject('DRIZZLE_DB')
    private readonly db: NodePgDatabase<typeof schema>,
    @Inject('DEVICE_ADMIN_DB')
    private readonly adminDb: NodePgDatabase<typeof schema>,
  ) {}

  async listPending(tenantId: string) {
    if (!UUID_RE.test(tenantId)) throw new BadRequestException('tenantId UUID requis.');

    return withTenant(this.db, tenantId, async (tx) => {
      const result = await tx.execute(sql`
        SELECT
          d.id,
          d.tenant_id,
          d.store_id,
          d.pos_profile_id,
          d.name,
          d.fingerprint,
          d.hardware_info,
          d.created_at
        FROM public.devices AS d
        WHERE d.tenant_id = ${tenantId}::uuid
          AND d.approval_status = 'pending_approval'
        ORDER BY d.created_at ASC, d.id ASC
        LIMIT 100
      `);
      return result.rows;
    });
  }

  async transition(input: {
    tenantId: string;
    deviceId: string;
    actorId: string;
    action: DeviceApprovalAction;
    reason?: string;
  }) {
    if (!UUID_RE.test(input.tenantId) || !UUID_RE.test(input.deviceId) ||
        !UUID_RE.test(input.actorId)) {
      throw new BadRequestException('Identités tenant, terminal et acteur UUID requises.');
    }
    if (!['approve', 'reject', 'revoke'].includes(input.action)) {
      throw new BadRequestException('Action de gestion du terminal invalide.');
    }

    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length > 500) throw new BadRequestException('reason ne peut dépasser 500 caractères.');
    if (input.action !== 'approve' && !reason) {
      throw new BadRequestException('Une justification est obligatoire pour rejeter ou révoquer un terminal.');
    }

    try {
      const result = await this.adminDb.execute(sql`
        SELECT *
        FROM public.transition_device_approval(
          ${input.tenantId}::uuid,
          ${input.deviceId}::uuid,
          ${input.actorId}::uuid,
          ${input.action}::text,
          ${reason || null}::varchar
        )
      `);
      const row = result.rows[0];
      if (!row) throw new NotFoundException('Terminal introuvable pour ce tenant.');
      return {
        deviceId: row.device_id,
        approvalStatus: row.approval_status,
        approvedAt: row.approved_at,
        approvedBy: row.approved_by,
        changedAt: row.changed_at,
      };
    } catch (error) {
      if (error instanceof BadRequestException ||
          error instanceof ConflictException ||
          error instanceof NotFoundException) throw error;

      const code = (error as { code?: string }).code;
      if (code === 'P0002') throw new NotFoundException('Terminal introuvable pour ce tenant.');
      if (code === 'P0001') throw new ConflictException('Transition de terminal impossible depuis son état actuel.');
      if (code === '22023') throw new BadRequestException('Paramètres de transition de terminal invalides.');
      throw error;
    }
  }
}
