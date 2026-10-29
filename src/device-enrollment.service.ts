import {
  BadRequestException,
  ConflictException,
  Injectable,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { devices } from './schema.js';
import type { EnrollDeviceDto } from './device-enrollment.dto.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Enrollment uses a single conditional UPDATE as the one-time-code lock.
 * PostgreSQL rechecks the WHERE predicate after waiting for a concurrent
 * updater, so at most one transaction can consume a code. Device creation
 * happens in that same transaction; a failed insert rolls the consumption back.
 */
@Injectable()
export class DeviceEnrollmentService {
  constructor(
    @Inject('DRIZZLE_DB')
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async enrollDevice(dto: EnrollDeviceDto, hardwareId: string) {
    if (typeof hardwareId !== 'string' || !hardwareId.trim() || hardwareId.length > 255) {
      throw new BadRequestException('En-tête X-Device-Fingerprint requis (1 à 255 caractères).');
    }

    // The issuer that creates pairing codes must persist this exact SHA-256
    // digest of the normalized XXXX-XXXX value in device_pairing_codes.code_hash.
    const codeHash = createHash('sha256').update(dto.activationCode, 'utf8').digest('hex');
    const now = new Date();

    try {
      return await this.db.transaction(async (tx) => {
        // One atomic compare-and-set. Never SELECT first and then UPDATE.
        const consumed = await tx.execute(sql`
          SELECT id, tenant_id, store_id, pos_profile_id
          FROM public.redeem_device_pairing_code(${codeHash})
        `);

        const pairing = consumed.rows[0] as
          | { id: string; tenant_id: string; store_id: string; pos_profile_id: string | null }
          | undefined;
        if (!pairing) {
          throw new BadRequestException("Code d'activation invalide, expiré ou déjà utilisé.");
        }
        if (!UUID_RE.test(pairing.tenant_id) || !UUID_RE.test(pairing.store_id)) {
          throw new ServiceUnavailableException("La configuration du code d'activation est invalide.");
        }

        // The devices table is tenant-RLS protected. Set the tenant context
        // within this transaction before inserting the device record.
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${pairing.tenant_id}, true)`);

        const [device] = await tx.insert(devices).values({
          id: randomUUID(),
          tenantId: pairing.tenant_id,
          storeId: pairing.store_id,
          posProfileId: pairing.pos_profile_id,
          name: dto.deviceName,
          fingerprint: hardwareId.trim(),
          hardwareInfo: { ...dto.hardwareInfo },
          isActive: true,
          createdAt: now,
        }).returning({
          id: devices.id,
          tenantId: devices.tenantId,
          storeId: devices.storeId,
          posProfileId: devices.posProfileId,
          name: devices.name,
        });

        if (!device) {
          throw new ServiceUnavailableException("L'enregistrement du poste de caisse a échoué.");
        }

        return {
          success: true,
          data: {
            deviceId: device.id,
            tenantId: device.tenantId,
            store: { id: device.storeId },
            posProfileId: device.posProfileId,
            deviceName: device.name,
            status: 'enrolled',
          },
        };
      });
    } catch (error) {
      if (error instanceof BadRequestException ||
          error instanceof ServiceUnavailableException) throw error;
      // Drizzle wraps PostgreSQL driver errors in a query error; inspect the
      // nested cause as well so unique-constraint conflicts are mapped reliably.
      let current: unknown = error;
      const seen = new Set<unknown>();
      while (current && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        const candidate = current as { code?: unknown; cause?: unknown };
        if (candidate.code === '23505') {
          throw new ConflictException('Ce poste est déjà enrôlé pour ce tenant.');
        }
        current = candidate.cause;
      }
      throw error;
    }
  }
}
