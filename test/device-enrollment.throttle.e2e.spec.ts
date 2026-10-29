import { Test } from '@nestjs/testing';
import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { SyncPullService } from '../src/sync-pull.service.js';
import { SyncPushService } from '../src/sync-push.service.js';
import { SyncConflictService } from '../src/sync-conflict.service.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';
import { DeviceEnrollmentController } from '../src/device-enrollment.controller.js';
import { DeviceEnrollmentService } from '../src/device-enrollment.service.js';
import { createDeviceEnrollmentThrottleModule } from '../src/device-enrollment.throttle.js';
import { SyncController } from '../src/sync.controller.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('Device enrollment rate limit (HTTP integration)', () => {
  let app: INestApplication;
  const enrollmentService = {
    enrollDevice: vi.fn().mockResolvedValue({
      success: true,
      data: {
        deviceId: 'device-test',
        tenantId: 'tenant-test',
        store: { id: 'store-test' },
        posProfileId: null,
        deviceName: 'Caisse test',
        status: 'enrolled',
      },
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [createDeviceEnrollmentThrottleModule(null)],
      controllers: [DeviceEnrollmentController, SyncController],
      providers: [
        { provide: DeviceEnrollmentService, useValue: enrollmentService },
        { provide: SyncPullService, useValue: { pullChanges: vi.fn() } },
        { provide: SyncPushService, useValue: { pushChanges: vi.fn() } },
        { provide: SyncConflictService, useValue: { listConflicts: vi.fn(), resolveConflict: vi.fn() } },
        {
          provide: JwtAuthGuard,
          useValue: {
            canActivate: () => {
              throw new UnauthorizedException('Authorization required for POS sync.');
            },
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const payload = {
    activationCode: 'ABCD-1234',
    deviceName: 'Caisse test',
    hardwareInfo: {
      hostname: 'pos-test',
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0',
    },
  };

  it('allows five enrollments, rejects the sixth with 429, and does not throttle POS sync routes', async () => {
    const server = app.getHttpServer();

    const first = await request(server)
      .post('/api/v1/devices/enroll')
      .set('X-Device-Fingerprint', 'fingerprint-1')
      .send(payload);
    expect(first.status).toBe(201);
    expect(first.body.success).toBe(true);

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      const response = await request(server)
        .post('/api/v1/devices/enroll')
        .set('X-Device-Fingerprint', `fingerprint-${attempt}`)
        .send(payload);
      expect(response.status).toBe(201);
    }

    const sixth = await request(server)
      .post('/api/v1/devices/enroll')
      .set('X-Device-Fingerprint', 'fingerprint-6')
      .send(payload);
    expect(sixth.status).toBe(429);
    expect(enrollmentService.enrollDevice).toHaveBeenCalledTimes(5);

    // The sync endpoint keeps its own authentication contract and is not
    // blocked by the enrollment-specific throttler.
    const sync = await request(server)
      .post('/sync/pull')
      .send({ last_pulled_at: null });
    expect(sync.status).toBe(401);
    expect(sync.status).not.toBe(429);
  });
});
