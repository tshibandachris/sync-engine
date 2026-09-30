import { Module, type DynamicModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { SyncPullService } from './sync-pull.service.js';
import { SyncPushService } from './sync-push.service.js';
import { SyncConflictService } from './sync-conflict.service.js';
import { SyncMaintenanceService } from './sync-maintenance.service.js';
import { SyncController } from './sync.controller.js';
import { AttachmentController } from './sync-attachment.controller.js';
import { AttachmentService } from './sync-attachment.service.js';
import type { AttachmentStorage } from './attachment-storage.js';

export const ATTACHMENT_STORAGE = 'ATTACHMENT_STORAGE';
import { AuthController } from './auth.controller.js';
import { JwtAuthGuard } from './jwt.guard.js';

export interface AppModuleOptions {
  db: NodePgDatabase<typeof schema>;
  jwtSecret: string;
  storage: AttachmentStorage;
  jwtExpiresIn?: number | string;
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    const { db, jwtSecret, storage, jwtExpiresIn = '30d' } = options;
    return {
      module: AppModule,
      imports: [
        JwtModule.register({
          secret: jwtSecret,
          signOptions: { expiresIn: jwtExpiresIn as any },
        }),
      ],
      controllers: [SyncController, AuthController, AttachmentController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: db },
        { provide: SyncPullService, useFactory: (d: any) => new SyncPullService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncPushService, useFactory: (d: any) => new SyncPushService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncConflictService, useFactory: (d: any) => new SyncConflictService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncMaintenanceService, useFactory: (d: any) => new SyncMaintenanceService(d), inject: ['DRIZZLE_DB'] },
        { provide: ATTACHMENT_STORAGE, useValue: storage },
        { provide: AttachmentService, useFactory: (d: any, s: any) => new AttachmentService(d, s), inject: ['DRIZZLE_DB', ATTACHMENT_STORAGE] },
        JwtAuthGuard,
      ],
      exports: [JwtAuthGuard],
    };
  }
}