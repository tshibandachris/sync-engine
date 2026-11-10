import { Module, type DynamicModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { SyncPullService } from './sync-pull.service.js';
import { SyncPushService } from './sync-push.service.js';
import { SyncConflictService } from './sync-conflict.service.js';
import { SyncMaintenanceService } from './sync-maintenance.service.js';
import { SyncController } from './sync.controller.js';
import { CashSessionController } from './cash-session.controller.js';
import { CashSessionService } from './cash-session.service.js';
import { AttachmentController } from './sync-attachment.controller.js';
import { AttachmentService } from './sync-attachment.service.js';
import { CourrierController } from './courrier.controller.js';
import { CourrierService } from './courrier.service.js';
import { DeviceEnrollmentController } from './device-enrollment.controller.js';
import { DeviceEnrollmentService } from './device-enrollment.service.js';
import { DeviceStatusController } from './device-status.controller.js';
import { DeviceStatusService } from './device-status.service.js';
import { createDeviceEnrollmentThrottleModule } from './device-enrollment.throttle.js';
import type { AttachmentStorage } from './attachment-storage.js';

export const ATTACHMENT_STORAGE = 'ATTACHMENT_STORAGE';
import { AuthController } from './auth.controller.js';
import { JwtAuthGuard } from './jwt.guard.js';
import { DeviceApprovalGuard } from './device-approval.guard.js';
import { DeviceProofGuard } from './auth/device-proof.guard.js';
import { DeviceProofNonceRepository } from './auth/device-proof-nonce.repository.js';
import { DeviceRepository } from './devices/device.repository.js';
import { SyncLogService } from './observability/sync-log.service.js';
import { SyncLogInterceptor } from './observability/sync-log.interceptor.js';

export interface AppModuleOptions {
  db: NodePgDatabase<typeof schema>;
  enrollmentDb: NodePgDatabase<typeof schema>;
  jwtSecret: string;
  storage: AttachmentStorage;
  jwtExpiresIn?: number | string;
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    const { db, enrollmentDb, jwtSecret, storage, jwtExpiresIn = '30d' } = options;
    return {
      module: AppModule,
      imports: [
        JwtModule.register({
          secret: jwtSecret,
          signOptions: { expiresIn: jwtExpiresIn as any },
        }),
        createDeviceEnrollmentThrottleModule(),
      ],
      controllers: [SyncController, AuthController, AttachmentController, CashSessionController, CourrierController, DeviceEnrollmentController, DeviceStatusController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: db },
        { provide: 'DEVICE_ENROLLMENT_DB', useValue: enrollmentDb },
        { provide: SyncPullService, useFactory: (d: any) => new SyncPullService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncPushService, useFactory: (d: any) => new SyncPushService(d), inject: ['DRIZZLE_DB'] },
        { provide: CashSessionService, useFactory: (d: any) => new CashSessionService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncConflictService, useFactory: (d: any) => new SyncConflictService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncMaintenanceService, useFactory: (d: any) => new SyncMaintenanceService(d), inject: ['DRIZZLE_DB'] },
        { provide: ATTACHMENT_STORAGE, useValue: storage },
        { provide: AttachmentService, useFactory: (d: any, s: any) => new AttachmentService(d, s), inject: ['DRIZZLE_DB', ATTACHMENT_STORAGE] },
        { provide: CourrierService, useFactory: (d: any, s: any) => new CourrierService(d, s), inject: ['DRIZZLE_DB', ATTACHMENT_STORAGE] },
        { provide: DeviceEnrollmentService, useFactory: (e: any) => new DeviceEnrollmentService(e), inject: ['DEVICE_ENROLLMENT_DB'] },
        { provide: DeviceStatusService, useFactory: (d: any) => new DeviceStatusService(d), inject: ['DRIZZLE_DB'] },
        JwtAuthGuard,
        DeviceApprovalGuard,
        DeviceProofGuard,
        DeviceProofNonceRepository,
        DeviceRepository,
        SyncLogService,
        { provide: APP_INTERCEPTOR, useClass: SyncLogInterceptor },
      ],
      exports: [JwtAuthGuard],
    };
  }
}
