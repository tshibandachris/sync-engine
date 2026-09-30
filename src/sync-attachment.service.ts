import { BadRequestException, ConflictException, ForbiddenException, Inject, NotFoundException } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from './schema.js';
import type { AttachmentStorage } from './attachment-storage.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKSUM_RE = /^[0-9a-f]{64}$/i;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/heic'];
const MAX_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_PER_CHECK_IN = 5;
const PUT_TTL_SECONDS = 15 * 60;
const GET_TTL_SECONDS = 60 * 60;

export interface RequestUploadDto {
  tenantId: string;
  agentId: string;
  checkInId: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
}

export interface RequestUploadResult {
  attachment_id: string;
  object_key: string;
  upload_url: string;
  expires_in: number;
}

export interface ConfirmUploadDto {
  tenantId: string;
  agentId: string;
  attachmentId: string;
}

export interface ConfirmUploadResult {
  attachment_id: string;
  status: 'uploaded';
  uploaded_at: number;
}

export interface ListAttachmentsDto {
  tenantId: string;
  agentId: string;
  checkInId: string;
}

export interface AttachmentItem {
  id: string;
  check_in_id: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  uploaded_at: number | null;
  download_url: string;
  expires_in: number;
}

export class AttachmentService {
  private readonly db: NodePgDatabase<typeof schema>;
  private readonly storage: AttachmentStorage;

  constructor(db: NodePgDatabase<typeof schema>, storage: AttachmentStorage) {
    this.db = db;
    this.storage = storage;
  }

  async requestUpload(dto: RequestUploadDto): Promise<RequestUploadResult> {
    if (!UUID_RE.test(dto.tenantId)) throw new BadRequestException('tenantId UUID requis.');
    if (!UUID_RE.test(dto.agentId)) throw new BadRequestException('agentId UUID requis.');
    if (!UUID_RE.test(dto.checkInId)) throw new BadRequestException('checkInId UUID requis.');
    if (!ALLOWED_TYPES.includes(dto.contentType)) {
      throw new BadRequestException('content_type non supporte : ' + dto.contentType);
    }
    if (!Number.isInteger(dto.sizeBytes) || dto.sizeBytes <= 0) {
      throw new BadRequestException('size_bytes invalide.');
    }
    if (dto.sizeBytes > MAX_SIZE_BYTES) {
      throw new BadRequestException('size_bytes depasse 10 Mo.');
    }
    if (!CHECKSUM_RE.test(dto.checksumSha256)) {
      throw new BadRequestException('checksum_sha256 invalide (64 hex).');
    }

    const checkIn = await this.db
      .select({ id: schema.checkIns.id })
      .from(schema.checkIns)
      .where(and(
        eq(schema.checkIns.id, dto.checkInId),
        eq(schema.checkIns.tenantId, dto.tenantId),
        eq(schema.checkIns.agentId, dto.agentId),
      ));

    if (checkIn.length !== 1) {
      throw new ForbiddenException('Check-in introuvable ou non accessible.');
    }

    const existing = await this.db
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(and(
        eq(schema.attachments.tenantId, dto.tenantId),
        eq(schema.attachments.checkInId, dto.checkInId),
      ));

    if (existing.length >= MAX_PER_CHECK_IN) {
      throw new ConflictException('Maximum ' + MAX_PER_CHECK_IN + ' pieces jointes par check-in.');
    }

    const attachmentId = randomUUID();
    const ext = dto.contentType === 'image/png' ? 'png'
      : dto.contentType === 'image/heic' ? 'heic'
      : 'jpg';
    const objectKey = 'tenants/' + dto.tenantId + '/checkins/' + dto.checkInId + '/' + attachmentId + '.' + ext;

    await this.db.insert(schema.attachments).values({
      id: attachmentId,
      tenantId: dto.tenantId,
      checkInId: dto.checkInId,
      agentId: dto.agentId,
      objectKey,
      contentType: dto.contentType,
      sizeBytes: dto.sizeBytes,
      checksumSha256: dto.checksumSha256.toLowerCase(),
      status: 'pending',
      createdAt: Date.now(),
    });

    const presigned = await this.storage.presignPut(objectKey, dto.contentType, PUT_TTL_SECONDS);

    return {
      attachment_id: attachmentId,
      object_key: objectKey,
      upload_url: presigned.url,
      expires_in: presigned.expiresIn,
    };
  }

  async confirmUpload(dto: ConfirmUploadDto): Promise<ConfirmUploadResult> {
    if (!UUID_RE.test(dto.tenantId)) throw new BadRequestException('tenantId UUID requis.');
    if (!UUID_RE.test(dto.agentId)) throw new BadRequestException('agentId UUID requis.');
    if (!UUID_RE.test(dto.attachmentId)) throw new BadRequestException('attachmentId UUID requis.');

    const rows = await this.db
      .select()
      .from(schema.attachments)
      .where(and(
        eq(schema.attachments.id, dto.attachmentId),
        eq(schema.attachments.tenantId, dto.tenantId),
        eq(schema.attachments.agentId, dto.agentId),
      ));

    const attachment = rows[0];
    if (!attachment) throw new NotFoundException('Piece jointe introuvable.');
    if (attachment.status === 'uploaded') {
      return { attachment_id: attachment.id, status: 'uploaded', uploaded_at: attachment.uploadedAt ?? Date.now() };
    }
    if (attachment.status !== 'pending') {
      throw new ConflictException('Piece jointe dans un etat non confirme : ' + attachment.status);
    }

    const head = await this.storage.head(attachment.objectKey);
    if (!head.exists) {
      throw new ConflictException('Objet absent du stockage. Upload non effectue.');
    }

    const uploadedAt = Date.now();
    await this.db
      .update(schema.attachments)
      .set({ status: 'uploaded', uploadedAt })
      .where(and(
        eq(schema.attachments.id, attachment.id),
        eq(schema.attachments.tenantId, dto.tenantId),
      ));

    return { attachment_id: attachment.id, status: 'uploaded', uploaded_at: uploadedAt };
  }

  async listForCheckIn(dto: ListAttachmentsDto): Promise<AttachmentItem[]> {
    if (!UUID_RE.test(dto.checkInId)) throw new BadRequestException('checkInId UUID requis.');

    const rows = await this.db
      .select()
      .from(schema.attachments)
      .where(and(
        eq(schema.attachments.tenantId, dto.tenantId),
        eq(schema.attachments.agentId, dto.agentId),
        eq(schema.attachments.checkInId, dto.checkInId),
        eq(schema.attachments.status, 'uploaded'),
      ))
      .orderBy(desc(schema.attachments.uploadedAt));

    const items: AttachmentItem[] = [];
    for (const r of rows) {
      const signed = await this.storage.presignGet(r.objectKey, GET_TTL_SECONDS);
      items.push({
        id: r.id,
        check_in_id: r.checkInId,
        content_type: r.contentType,
        size_bytes: Number(r.sizeBytes),
        checksum_sha256: r.checksumSha256,
        uploaded_at: r.uploadedAt === null ? null : Number(r.uploadedAt),
        download_url: signed.url,
        expires_in: signed.expiresIn,
      });
    }
    return items;
  }
}
