import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { withTenant } from './with-tenant.js';
import { requireTenantId } from './tenant-id.js';

export interface CloseCashSessionDto {
  closingAmount: number;
  notes?: string | null;
}

/**
 * Dedicated, authenticated lifecycle operation. The server derives expected
 * cash from opening float plus cash portions of sales (void sales are negative).
 * Client-supplied expected_amount/difference are never accepted.
 */
export class CashSessionService {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async closeSession(id: string, tenantIdRaw: string | undefined, body: CloseCashSessionDto) {
    const tenantId = requireTenantId(tenantIdRaw, 'tenantId (cash session close)');
    if (!Number.isInteger(body?.closingAmount) || body.closingAmount < 0 ||
        !Number.isSafeInteger(body.closingAmount)) {
      throw new BadRequestException('closingAmount doit être un entier sûr positif ou nul.');
    }
    if (body.notes !== undefined && body.notes !== null &&
        (typeof body.notes !== 'string' || body.notes.length > 500)) {
      throw new BadRequestException('notes doit contenir au maximum 500 caractères.');
    }

    return withTenant(this.db, tenantId, async (tx) => {
      const locked = await tx.execute(sql`
        SELECT id, staff_id, status, opened_at, opening_amount, closed_at, closing_amount, expected_amount, difference, notes, sync_seq
        FROM cash_sessions
        WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid
        FOR UPDATE
      `);
      const session = locked.rows[0] as Record<string, unknown> | undefined;
      if (!session) throw new NotFoundException('Session de caisse introuvable.');
      if (session.status === 'closed') {
        if (Number(session.closing_amount) === body.closingAmount && (body.notes === undefined || body.notes === session.notes)) {
          return {
            id: String(session.id), staffId: String(session.staff_id), status: 'closed',
            openedAt: Number(session.opened_at), closedAt: Number(session.closed_at),
            openingAmount: Number(session.opening_amount), closingAmount: Number(session.closing_amount),
            expectedAmount: Number(session.expected_amount), difference: Number(session.difference),
            notes: session.notes === null ? null : String(session.notes), syncSeq: Number(session.sync_seq),
          };
        }
        throw new ConflictException('Cette session de caisse est déjà clôturée avec un autre montant.');
      }

      const totals = await tx.execute(sql`
        SELECT COALESCE(SUM(cash_amount), 0)::bigint AS cash_sales
        FROM sales
        WHERE tenant_id = ${tenantId}::uuid
          AND cash_session_id = ${id}::uuid
      `);
      const cashSales = Number((totals.rows[0] as Record<string, unknown>).cash_sales ?? 0);
      const expectedAmount = Number(session.opening_amount) + cashSales;
      const difference = body.closingAmount - expectedAmount;
      const closedAt = Date.now();

      const updated = await tx.execute(sql`
        UPDATE cash_sessions
        SET status = 'closed',
            closed_at = ${closedAt},
            closing_amount = ${body.closingAmount},
            expected_amount = ${expectedAmount},
            difference = ${difference},
            notes = ${body.notes === undefined ? session.notes : body.notes}
        WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid AND status = 'open'
        RETURNING id, staff_id, status, opened_at, closed_at, opening_amount,
                  closing_amount, expected_amount, difference, notes, sync_seq
      `);
      const row = updated.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new ConflictException('La session a changé pendant sa clôture.');
      return {
        id: String(row.id),
        staffId: String(row.staff_id),
        status: String(row.status),
        openedAt: Number(row.opened_at),
        closedAt: Number(row.closed_at),
        openingAmount: Number(row.opening_amount),
        closingAmount: Number(row.closing_amount),
        expectedAmount: Number(row.expected_amount),
        difference: Number(row.difference),
        notes: row.notes === null ? null : String(row.notes),
        syncSeq: Number(row.sync_seq),
      };
    }, { write: true });
  }
}
