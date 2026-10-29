import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from './schema.js';
import { withTenant } from './with-tenant.js';
import { requireTenantId } from './tenant-id.js';
import {
  canActOnMail,
  canReadMail,
  effectiveClearance,
  filterVisibleMails,
  hasPermission,
  requireConfidentiality,
  type CourrierAccessContext,
  type CourrierAssignment,
  type Confidentiality,
} from './courrier-policy.js';
import type { AttachmentStorage } from './attachment-storage.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKSUM_RE = /^[0-9a-f]{64}$/i;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const PUT_TTL_SECONDS = 15 * 60;
const GET_TTL_SECONDS = 60 * 60;
const ALLOWED_CONTENT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

export interface CourrierActor {
  tenantId: string;
  agentId: string;
  permissions?: readonly string[];
  serviceIds?: readonly string[];
}

export interface CreateCourrierDto {
  subject: string;
  body?: string;
  confidentiality?: unknown;
}

export interface RequestCourrierAttachmentDto {
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
}

type CourrierRow = typeof schema.courriers.$inferSelect;

type CourrierStatus = 'enregistre' | 'affecte' | 'en_cours' | 'repondu' | 'clos' | 'archive';
type AssignmentTarget = { agentId?: string; serviceId?: string };

const NEXT_STATUSES: Record<CourrierStatus, readonly CourrierStatus[]> = {
  enregistre: ['affecte'],
  affecte: ['en_cours'],
  en_cours: ['repondu'],
  repondu: ['clos'],
  clos: ['archive'],
  archive: [],
};


export class CourrierService {
  constructor(
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly storage: AttachmentStorage,
  ) {}

  private context(actor: CourrierActor): CourrierAccessContext {
    const permissions = new Set(actor.permissions ?? []);
    return {
      tenantId: requireTenantId(actor.tenantId),
      actorId: this.requireUuid(actor.agentId, 'agentId'),
      permissions,
      clearance: effectiveClearance(permissions),
      serviceIds: new Set(actor.serviceIds ?? []),
    };
  }


  private async assignmentsFor(tx: any, tenantId: string, courrierId: string): Promise<CourrierAssignment[]> {
    const rows = await tx.select().from(schema.courrierAssignments).where(and(
      eq(schema.courrierAssignments.tenantId, tenantId),
      eq(schema.courrierAssignments.courrierId, courrierId),
      isNull(schema.courrierAssignments.revokedAt),
    ));
    return rows.map((row: typeof schema.courrierAssignments.$inferSelect) => ({
      tenantId: row.tenantId,
      mailId: row.courrierId,
      userId: row.agentId,
      serviceId: row.serviceId,
    }));
  }

  private async audit(
    tx: any,
    context: CourrierAccessContext,
    courrierId: string,
    action: string,
    details: { fromStatus?: string | null; toStatus?: string | null; metadata?: Record<string, unknown> } = {},
  ): Promise<void> {
    await tx.insert(schema.courrierAuditLogs).values({
      id: randomUUID(),
      tenantId: context.tenantId,
      courrierId,
      actorId: context.actorId,
      action,
      fromStatus: details.fromStatus ?? null,
      toStatus: details.toStatus ?? null,
      metadata: details.metadata ?? {},
      createdAt: Date.now(),
    });
  }

  private requireUuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      throw new BadRequestException(field + ' UUID requis.');
    }
    return value;
  }

  private toPolicyRecord(row: CourrierRow) {
    return {
      id: row.id,
      tenantId: row.tenantId,
      createdBy: row.agentId,
      confidentiality: row.confidentiality as Confidentiality,
    };
  }

  private assertReadable(
    context: CourrierAccessContext,
    row: CourrierRow,
    assignments: readonly CourrierAssignment[] = [],
  ): void {
    if (!canReadMail(context, this.toPolicyRecord(row), assignments)) {
      // Do not disclose whether a record exists outside the caller's visibility.
      throw new NotFoundException('Courrier introuvable.');
    }
  }

  async create(actor: CourrierActor, dto: CreateCourrierDto) {
    const context = this.context(actor);
    if (!hasPermission(context, 'courrier:register')) {
      throw new ForbiddenException('Permission courrier:register requise.');
    }
    if (typeof dto?.subject !== 'string' || !dto.subject.trim() || dto.subject.trim().length > 200) {
      throw new BadRequestException('subject requis (1 à 200 caractères).');
    }
    if (dto.body !== undefined && (typeof dto.body !== 'string' || dto.body.length > 100_000)) {
      throw new BadRequestException('body doit être un texte de 100 000 caractères maximum.');
    }

    let confidentiality: Confidentiality;
    try {
      confidentiality = requireConfidentiality(dto.confidentiality ?? 'interne');
    } catch {
      throw new BadRequestException('Niveau de confidentialité invalide.');
    }
    if (
      confidentiality === 'secret' &&
      !context.permissions.has('*') &&
      !context.permissions.has('clearance:secret')
    ) {
      throw new ForbiddenException('Autorisation de créer un courrier secret requise.');
    }
    if (
      confidentiality === 'confidentiel' &&
      !context.permissions.has('*') &&
      !context.permissions.has('clearance:confidentiel') &&
      !context.permissions.has('clearance:secret')
    ) {
      throw new ForbiddenException('Habilitation confidentielle requise.');
    }

    const now = Date.now();
    return withTenant(this.db, context.tenantId, async (tx) => {
      const rows = await tx.insert(schema.courriers).values({
        id: randomUUID(),
        tenantId: context.tenantId,
        agentId: context.actorId,
        subject: dto.subject.trim(),
        body: dto.body ?? '',
        confidentiality,
        status: 'enregistre',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        syncSeq: 0,
        firstSyncSeq: 0,
      }).returning();
      await this.audit(tx, context, rows[0].id, 'courrier.created', { toStatus: 'enregistre' });
      return rows[0];
    }, { write: true });
  }

  async list(actor: CourrierActor, limitRaw?: number) {
    const context = this.context(actor);
    if (!hasPermission(context, 'courrier:read')) {
      throw new ForbiddenException('Permission courrier:read requise.');
    }
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit doit être compris entre 1 et 100.');
    }

    return withTenant(this.db, context.tenantId, async (tx) => {
      const rows = await tx.select().from(schema.courriers)
        .where(and(eq(schema.courriers.tenantId, context.tenantId), isNull(schema.courriers.deletedAt)))
        .orderBy(desc(schema.courriers.createdAt))
        .limit(500);
      const assignmentRows = rows.length ? await tx.select().from(schema.courrierAssignments).where(and(
        eq(schema.courrierAssignments.tenantId, context.tenantId),
        inArray(schema.courrierAssignments.courrierId, rows.map((row) => row.id)),
        isNull(schema.courrierAssignments.revokedAt),
      )) : [];
      const assignments: CourrierAssignment[] = assignmentRows.map((row) => ({
        tenantId: row.tenantId, mailId: row.courrierId, userId: row.agentId, serviceId: row.serviceId,
      }));
      const visible = filterVisibleMails(
        context,
        rows.map((row) => ({ ...this.toPolicyRecord(row), row })),
        assignments,
      ).slice(0, limit);
      for (const item of visible) await this.audit(tx, context, item.row.id, 'courrier.listed');
      return visible.map(({ row }) => row);
    });
  }

  async get(actor: CourrierActor, idRaw: string) {
    const context = this.context(actor);
    const id = this.requireUuid(idRaw, 'courrierId');
    return withTenant(this.db, context.tenantId, async (tx) => {
      const rows = await tx.select().from(schema.courriers).where(and(
        eq(schema.courriers.id, id),
        eq(schema.courriers.tenantId, context.tenantId),
        isNull(schema.courriers.deletedAt),
      )).limit(1);
      const row = rows[0];
      if (!row) throw new NotFoundException('Courrier introuvable.');
      const assignments = await this.assignmentsFor(tx, context.tenantId, row.id);
      this.assertReadable(context, row, assignments);
      await this.audit(tx, context, row.id, 'courrier.read');
      return row;
    });
  }

  async requestAttachment(actor: CourrierActor, courrierIdRaw: string, dto: RequestCourrierAttachmentDto) {
    const context = this.context(actor);
    const courrierId = this.requireUuid(courrierIdRaw, 'courrierId');
    if (!ALLOWED_CONTENT_TYPES.has(dto?.contentType)) {
      throw new BadRequestException('content_type accepté : application/pdf, image/jpeg, image/png.');
    }
    if (!Number.isSafeInteger(dto.sizeBytes) || dto.sizeBytes <= 0 || dto.sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException('size_bytes doit être compris entre 1 octet et 10 Mio.');
    }
    if (!CHECKSUM_RE.test(dto.checksumSha256)) {
      throw new BadRequestException('checksum_sha256 doit contenir 64 caractères hexadécimaux.');
    }

    return withTenant(this.db, context.tenantId, async (tx) => {
      const rows = await tx.select().from(schema.courriers).where(and(
        eq(schema.courriers.id, courrierId),
        eq(schema.courriers.tenantId, context.tenantId),
        isNull(schema.courriers.deletedAt),
      )).limit(1);
      const courrier = rows[0];
      if (!courrier) throw new NotFoundException('Courrier introuvable.');
      const assignments = await this.assignmentsFor(tx, context.tenantId, courrierId);
      this.assertReadable(context, courrier, assignments);
      if (!canActOnMail(context, this.toPolicyRecord(courrier), assignments, 'transition')) {
        throw new ForbiddenException('Vous ne pouvez pas ajouter de pièce jointe à ce courrier.');
      }

      const id = randomUUID();
      const ext = dto.contentType === 'application/pdf' ? 'pdf' : dto.contentType === 'image/png' ? 'png' : 'jpg';
      const objectKey = 'tenants/' + context.tenantId + '/courriers/' + courrierId + '/' + id + '.' + ext;
      await tx.insert(schema.courrierAttachments).values({
        id,
        tenantId: context.tenantId,
        courrierId,
        agentId: context.actorId,
        objectKey,
        contentType: dto.contentType,
        sizeBytes: dto.sizeBytes,
        checksumSha256: dto.checksumSha256.toLowerCase(),
        status: 'pending',
        createdAt: Date.now(),
        uploadedAt: null,
      });
      await this.audit(tx, context, courrierId, 'courrier.attachment_upload_requested', { metadata: { attachmentId: id } });
      const signed = await this.storage.presignPut(objectKey, dto.contentType, PUT_TTL_SECONDS);
      return { attachment_id: id, upload_url: signed.url, expires_in: signed.expiresIn };
    }, { write: true });
  }

  async confirmAttachment(actor: CourrierActor, courrierIdRaw: string, attachmentIdRaw: string) {
    const context = this.context(actor);
    const courrierId = this.requireUuid(courrierIdRaw, 'courrierId');
    const attachmentId = this.requireUuid(attachmentIdRaw, 'attachmentId');
    return withTenant(this.db, context.tenantId, async (tx) => {
      const mailRows = await tx.select().from(schema.courriers).where(and(
        eq(schema.courriers.id, courrierId),
        eq(schema.courriers.tenantId, context.tenantId),
        isNull(schema.courriers.deletedAt),
      )).limit(1);
      const courrier = mailRows[0];
      if (!courrier) throw new NotFoundException('Courrier introuvable.');
      const assignments = await this.assignmentsFor(tx, context.tenantId, courrierId);
      this.assertReadable(context, courrier, assignments);
      if (!canActOnMail(context, this.toPolicyRecord(courrier), assignments, 'transition')) {
        throw new ForbiddenException('Vous ne pouvez pas confirmer une pièce jointe sur ce courrier.');
      }

      const rows = await tx.select().from(schema.courrierAttachments).where(and(
        eq(schema.courrierAttachments.id, attachmentId),
        eq(schema.courrierAttachments.courrierId, courrierId),
        eq(schema.courrierAttachments.tenantId, context.tenantId),
      )).limit(1);
      const attachment = rows[0];
      if (!attachment) throw new NotFoundException('Pièce jointe introuvable.');
      if (attachment.status === 'uploaded') {
        return { attachment_id: attachment.id, status: 'uploaded', uploaded_at: attachment.uploadedAt };
      }
      const head = await this.storage.head(attachment.objectKey);
      if (!head.exists) throw new ConflictException('Fichier absent du stockage : téléversement non confirmé.');
      if (head.sizeBytes !== undefined && head.sizeBytes !== Number(attachment.sizeBytes)) {
        throw new ConflictException('La taille du fichier ne correspond pas aux métadonnées déclarées.');
      }
      if (head.contentType !== undefined && head.contentType !== attachment.contentType) {
        throw new ConflictException('Le type du fichier ne correspond pas aux métadonnées déclarées.');
      }
      const uploadedAt = Date.now();
      await tx.update(schema.courrierAttachments).set({ status: 'uploaded', uploadedAt }).where(and(
        eq(schema.courrierAttachments.id, attachmentId),
        eq(schema.courrierAttachments.tenantId, context.tenantId),
      ));
      await this.audit(tx, context, courrierId, 'courrier.attachment_uploaded', { metadata: { attachmentId } });
      return { attachment_id: attachmentId, status: 'uploaded', uploaded_at: uploadedAt };
    }, { write: true });
  }


  async assign(actor: CourrierActor, courrierIdRaw: string, target: AssignmentTarget) {
    const context = this.context(actor);
    const courrierId = this.requireUuid(courrierIdRaw, 'courrierId');
    const agentId = target?.agentId === undefined ? undefined : this.requireUuid(target.agentId, 'agentId');
    const serviceId = target?.serviceId === undefined ? undefined : this.requireUuid(target.serviceId, 'serviceId');
    if (Boolean(agentId) === Boolean(serviceId)) {
      throw new BadRequestException('Fournissez exactement un agentId ou serviceId.');
    }
    if (!hasPermission(context, 'courrier:assign')) {
      throw new ForbiddenException('Permission courrier:assign requise.');
    }

    return withTenant(this.db, context.tenantId, async (tx) => {
      const rows = await tx.select().from(schema.courriers).where(and(
        eq(schema.courriers.id, courrierId),
        eq(schema.courriers.tenantId, context.tenantId),
        isNull(schema.courriers.deletedAt),
      )).limit(1);
      const row = rows[0];
      if (!row) throw new NotFoundException('Courrier introuvable.');
      const assignments = await this.assignmentsFor(tx, context.tenantId, courrierId);
      this.assertReadable(context, row, assignments);
      if (!canActOnMail(context, this.toPolicyRecord(row), assignments, 'assign')) {
        throw new ForbiddenException('Affectation non autorisée.');
      }

      const now = Date.now();
      const inserted = await tx.insert(schema.courrierAssignments).values({
        id: randomUUID(), tenantId: context.tenantId, courrierId,
        agentId: agentId ?? null, serviceId: serviceId ?? null,
        assignedBy: context.actorId, assignedAt: now, revokedAt: null,
      }).returning();
      const nextStatus: CourrierStatus = row.status === 'enregistre' ? 'affecte' : row.status as CourrierStatus;
      if (nextStatus !== row.status) {
        await tx.update(schema.courriers).set({ status: nextStatus, updatedAt: now }).where(and(
          eq(schema.courriers.id, courrierId), eq(schema.courriers.tenantId, context.tenantId),
        ));
      }
      await this.audit(tx, context, courrierId, 'courrier.assigned', {
        fromStatus: row.status, toStatus: nextStatus,
        metadata: { assignmentId: inserted[0].id, agentId: agentId ?? null, serviceId: serviceId ?? null },
      });
      return inserted[0];
    }, { write: true });
  }

  async transition(actor: CourrierActor, courrierIdRaw: string, toStatusRaw: unknown) {
    const context = this.context(actor);
    const courrierId = this.requireUuid(courrierIdRaw, 'courrierId');
    const statuses: readonly string[] = ['enregistre', 'affecte', 'en_cours', 'repondu', 'clos', 'archive'];
    if (typeof toStatusRaw !== 'string' || !statuses.includes(toStatusRaw)) {
      throw new BadRequestException('État cible invalide.');
    }
    const toStatus = toStatusRaw as CourrierStatus;
    return withTenant(this.db, context.tenantId, async (tx) => {
      const rows = await tx.select().from(schema.courriers).where(and(
        eq(schema.courriers.id, courrierId),
        eq(schema.courriers.tenantId, context.tenantId),
        isNull(schema.courriers.deletedAt),
      )).limit(1);
      const row = rows[0];
      if (!row) throw new NotFoundException('Courrier introuvable.');
      const assignments = await this.assignmentsFor(tx, context.tenantId, courrierId);
      this.assertReadable(context, row, assignments);
      const action = toStatus === 'clos' || toStatus === 'archive' ? 'close' : 'transition';
      if (!canActOnMail(context, this.toPolicyRecord(row), assignments, action)) {
        throw new ForbiddenException('Transition non autorisée.');
      }
      if (!(NEXT_STATUSES[row.status as CourrierStatus] ?? []).includes(toStatus)) {
        throw new ConflictException('Transition interdite de ' + row.status + ' vers ' + toStatus + '.');
      }
      const now = Date.now();
      const updated = await tx.update(schema.courriers).set({ status: toStatus, updatedAt: now })
        .where(and(eq(schema.courriers.id, courrierId), eq(schema.courriers.tenantId, context.tenantId)))
        .returning();
      await this.audit(tx, context, courrierId, 'courrier.status_changed', {
        fromStatus: row.status, toStatus, metadata: {},
      });
      return updated[0];
    }, { write: true });
  }

  async listAudit(actor: CourrierActor, courrierIdRaw: string, limitRaw?: number) {
    const context = this.context(actor);
    const courrierId = this.requireUuid(courrierIdRaw, 'courrierId');
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit doit être compris entre 1 et 100.');
    }
    if (!hasPermission(context, 'courrier:manage')) {
      throw new ForbiddenException('Permission courrier:manage requise pour consulter le journal.');
    }
    return withTenant(this.db, context.tenantId, async (tx) => {
      const rows = await tx.select().from(schema.courriers).where(and(
        eq(schema.courriers.id, courrierId), eq(schema.courriers.tenantId, context.tenantId),
        isNull(schema.courriers.deletedAt),
      )).limit(1);
      const courrier = rows[0];
      if (!courrier) throw new NotFoundException('Courrier introuvable.');
      const assignments = await this.assignmentsFor(tx, context.tenantId, courrierId);
      this.assertReadable(context, courrier, assignments);
      const logs = await tx.select().from(schema.courrierAuditLogs).where(and(
        eq(schema.courrierAuditLogs.tenantId, context.tenantId),
        eq(schema.courrierAuditLogs.courrierId, courrierId),
      )).orderBy(desc(schema.courrierAuditLogs.createdAt)).limit(limit);
      await this.audit(tx, context, courrierId, 'courrier.audit_read', { metadata: { returned: logs.length } });
      return logs;
    }, { write: true });
  }

  async listAttachments(actor: CourrierActor, courrierIdRaw: string) {
    const context = this.context(actor);
    const courrierId = this.requireUuid(courrierIdRaw, 'courrierId');
    return withTenant(this.db, context.tenantId, async (tx) => {
      const mailRows = await tx.select().from(schema.courriers).where(and(
        eq(schema.courriers.id, courrierId),
        eq(schema.courriers.tenantId, context.tenantId),
        isNull(schema.courriers.deletedAt),
      )).limit(1);
      const courrier = mailRows[0];
      if (!courrier) throw new NotFoundException('Courrier introuvable.');
      const assignments = await this.assignmentsFor(tx, context.tenantId, courrierId);
      this.assertReadable(context, courrier, assignments);
      await this.audit(tx, context, courrierId, 'courrier.attachments_read');
      const rows = await tx.select().from(schema.courrierAttachments).where(and(
        eq(schema.courrierAttachments.courrierId, courrierId),
        eq(schema.courrierAttachments.tenantId, context.tenantId),
        eq(schema.courrierAttachments.status, 'uploaded'),
      )).orderBy(desc(schema.courrierAttachments.createdAt));
      const result = [];
      for (const row of rows) {
        const signed = await this.storage.presignGet(row.objectKey, GET_TTL_SECONDS);
        result.push({
          id: row.id,
          courrier_id: row.courrierId,
          content_type: row.contentType,
          size_bytes: Number(row.sizeBytes),
          checksum_sha256: row.checksumSha256,
          uploaded_at: row.uploadedAt,
          download_url: signed.url,
          expires_in: signed.expiresIn,
        });
      }
      return result;
    });
  }
}
