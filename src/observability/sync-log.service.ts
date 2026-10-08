import { Inject, Injectable } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import * as schema from '../schema.js';
import { withTenant } from '../with-tenant.js';
import type { SyncOperation } from './metrics.types.js';

export interface SyncLogEntry {
  requestId: string;
  tenantId: string;
  agentId?: string | null;
  operation: SyncOperation;
  statusCode: number;
  startedAt: number;
  durationMs: number;
  recordsIn: number;
  recordsOut: number;
  conflicts: number;
  errors: number;
  idempotency?: 'hit' | 'miss' | null;
  schemaVersion?: string | null;
  errorCode?: string | null;
}

/**
 * Writes one row per /sync/* request into sync_logs.
 *
 * Never throws. A failure to persist observability data must not turn a
 * successful sync into an error. Failures are logged to stderr and dropped.
 */
@Injectable()
export class SyncLogService {
  constructor(@Inject('DRIZZLE_DB') private readonly db: NodePgDatabase<typeof schema>) {}

  async record(entry: SyncLogEntry): Promise<void> {
    try {
      await withTenant(this.db, entry.tenantId, async (tx) => {
        await tx.insert(schema.syncLogs).values({
          id: randomUUID(),
          requestId: entry.requestId,
          tenantId: entry.tenantId,
          agentId: entry.agentId ?? null,
          operation: entry.operation,
          statusCode: entry.statusCode,
          startedAt: entry.startedAt,
          durationMs: entry.durationMs,
          recordsIn: entry.recordsIn,
          recordsOut: entry.recordsOut,
          conflicts: entry.conflicts,
          errors: entry.errors,
          idempotency: entry.idempotency ?? null,
          schemaVersion: entry.schemaVersion ?? null,
          errorCode: entry.errorCode ?? null,
        });
      });
    } catch (err) {
      console.error('[sync-log] insert failed:', err);
    }
  }
}
