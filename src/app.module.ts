import { Module, type DynamicModule } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { SyncPullService } from './sync-pull.service.js';
import { SyncPushService } from './sync-push.service.js';
import { SyncConflictService } from './sync-conflict.service.js';
import { SyncMaintenanceService } from './sync-maintenance.service.js';
import { SyncController } from './sync.controller.js';

@Module({})
export class AppModule {
  static register(db: NodePgDatabase<typeof schema>): DynamicModule {
    return {
      module: AppModule,
      controllers: [SyncController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: db },
        { provide: SyncPullService, useFactory: (d: any) => new SyncPullService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncPushService, useFactory: (d: any) => new SyncPushService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncConflictService, useFactory: (d: any) => new SyncConflictService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncMaintenanceService, useFactory: (d: any) => new SyncMaintenanceService(d), inject: ['DRIZZLE_DB'] },
      ],
    };
  }
}