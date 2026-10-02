import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { requireTenantId } from '../src/tenant-id.js';
import { SyncPullService } from '../src/sync-pull.service.js';
import { SyncPushService } from '../src/sync-push.service.js';
import { SyncConflictService } from '../src/sync-conflict.service.js';

const AGENT = '00000000-0000-0000-0000-000000000001';
const TENANT = '00000000-0000-0000-0000-000000000002';
const CONFLICT = '00000000-0000-0000-0000-000000000003';

// Services are constructed with a stub db. The point is that the tenant
// check fires before any DB access, so a stub is sufficient.
const stubDb = {} as any;

describe('requireTenantId helper', () => {
  it('accepts a UUID', () => {
    expect(requireTenantId(TENANT)).toBe(TENANT);
  });

  it('rejects undefined', () => {
    expect(() => requireTenantId(undefined)).toThrow(BadRequestException);
  });

  it('rejects null', () => {
    expect(() => requireTenantId(null)).toThrow(BadRequestException);
  });

  it('rejects a non-UUID string', () => {
    expect(() => requireTenantId('not-a-uuid')).toThrow(BadRequestException);
  });
});

describe('services reject a missing tenantId (fail-closed)', () => {
  it('SyncPullService.pullChanges', async () => {
    const svc = new SyncPullService(stubDb);
    await expect(
      svc.pullChanges({ agentId: AGENT, tenantId: undefined }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('SyncPushService.pushChanges', async () => {
    const svc = new SyncPushService(stubDb);
    await expect(
      svc.pushChanges(
        AGENT,
        { changes: { check_ins: { created: [] } } },
        undefined,
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('SyncConflictService.listConflicts', async () => {
    const svc = new SyncConflictService(stubDb);
    await expect(
      svc.listConflicts({ agentId: AGENT, tenantId: undefined }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('SyncConflictService.resolveConflict', async () => {
    const svc = new SyncConflictService(stubDb);
    await expect(
      svc.resolveConflict({
        conflictId: CONFLICT,
        agentId: AGENT,
        resolvedBy: AGENT,
        resolution: 'dismiss',
        tenantId: undefined,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
