import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { CourrierService } from '../src/courrier.service.js';

function service() {
  const db = { transaction: vi.fn() };
  const storage = {
    delete: vi.fn(),
    listByPrefix: vi.fn(),
    presignPut: vi.fn(),
    presignGet: vi.fn(),
    head: vi.fn(),
  };
  return new CourrierService(db as any, storage as any);
}

const actor = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  agentId: '00000000-0000-4000-8000-000000000002',
};

describe('CourrierService access boundaries', () => {
  it('requires courrier:register before creating records', async () => {
    await expect(service().create(actor, { subject: 'Test' }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects invalid confidentiality before opening a database transaction', async () => {
    const svc = service();
    await expect(svc.create({ ...actor, permissions: ['courrier:register'] }, {
      subject: 'Test', confidentiality: 'top-secret',
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires explicit clearance for secret courrier creation', async () => {
    await expect(service().create({ ...actor, permissions: ['courrier:register'] }, {
      subject: 'Test', confidentiality: 'secret',
    })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects unsupported attachment MIME types before storage access', async () => {
    const svc = service();
    await expect(svc.requestAttachment({ ...actor, permissions: ['courrier:read', 'courrier:manage'] },
      '00000000-0000-4000-8000-000000000003', {
        contentType: 'application/x-msdownload', sizeBytes: 100, checksumSha256: 'a'.repeat(64),
      })).rejects.toBeInstanceOf(BadRequestException);
  });
});
