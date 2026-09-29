import { Module, type DynamicModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { SyncPullService } from './sync-pull.service.js';
import { SyncPushService } from './sync-push.service.js';
import { SyncConflictService } from './sync-conflict.service.js';
import { SyncMaintenanceService } from './sync-maintenance.service.js';
import { SyncController } from './sync.controller.js';
import { AuthController } from './auth.controller.js';
import { JwtAuthGuard } from './jwt.guard.js';

export interface AppModuleOptions {
  db: NodePgDatabase<typeof schema>;
  jwtSecret: string;
  jwtExpiresIn?: number | string;
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    const { db, jwtSecret, jwtExpiresIn = '30d' } = options;
    return {
      module: AppModule,
      imports: [
        JwtModule.register({
          secret: jwtSecret,
          signOptions: { expiresIn: jwtExpiresIn as any },
        }),
      ],
      controllers: [SyncController, AuthController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: db },
        { provide: SyncPullService, useFactory: (d: any) => new SyncPullService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncPushService, useFactory: (d: any) => new SyncPushService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncConflictService, useFactory: (d: any) => new SyncConflictService(d), inject: ['DRIZZLE_DB'] },
        { provide: SyncMaintenanceService, useFactory: (d: any) => new SyncMaintenanceService(d), inject: ['DRIZZLE_DB'] },
        JwtAuthGuard,
      ],
      exports: [JwtAuthGuard],
    };
  }
}