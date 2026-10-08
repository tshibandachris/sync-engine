import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { recordSyncCall } from './metrics.js';
import type { SyncOperation } from './metrics.types.js';
import { SyncLogService } from './sync-log.service.js';
import { IDEMPOTENCY_REPLAY } from '../sync-push.service.js';

interface RequestLike {
  method?: string;
  route?: { path?: string };
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  agentId?: string;
  tenantId?: string;
  requestId?: string;
}

interface ExtractedCounters {
  recordsIn: number;
  recordsOut: number;
  conflicts: number;
  idempotency: 'hit' | 'miss' | null;
}

/**
 * Records one sync_logs row and updates Prometheus counters for every
 * /sync/* request that reaches the controller.
 *
 * Runs after the JwtAuthGuard, so req.tenantId and req.agentId are set
 * whenever this interceptor is reached. Requests rejected by the guard
 * (401) are not logged here; they never enter the Nest pipeline past the
 * guard. That is acceptable: they carry no tenant.
 *
 * The actual write happens on the response 'finish' event, after Nest has
 * set the final HTTP status, so a @Post 201 is logged as 201, not 200.
 * Neither the DB write nor the Prometheus update is awaited — a slow or
 * failing observability sink must not delay or fail the response.
 */
@Injectable()
export class SyncLogInterceptor implements NestInterceptor {
  constructor(@Inject(SyncLogService) private readonly logs: SyncLogService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<RequestLike>();
    const res = http.getResponse<{ statusCode: number; on: (e: string, cb: () => void) => void }>();

    const operation = classifyOperation(req);
    if (!operation) return next.handle();

    const requestId = randomUUID();
    const startedAt = Date.now();
    req.requestId = requestId;

    // Captured from the rxjs pipeline, read back on 'finish'.
    let data: unknown = undefined;
    let err: unknown = undefined;

    res.on('finish', () => {
      const statusCode = res.statusCode;
      const durationMs = Date.now() - startedAt;
      const tenantId = req.tenantId;
      if (!tenantId) {
        // Should not happen: the guard sets it before this interceptor runs.
        console.error('[sync-log] request reached interceptor without tenantId; skipping');
        return;
      }

      const counters: ExtractedCounters = err
        ? { recordsIn: 0, recordsOut: 0, conflicts: 0, idempotency: null }
        : extractCounters(operation, data, req);
      const errorCode = err ? extractErrorCode(err) : null;
      const errors = err ? 1 : 0;

      // Prometheus: synchronous, never throws.
      recordSyncCall({
        operation,
        statusCode,
        durationMs,
        recordsIn: counters.recordsIn,
        recordsOut: counters.recordsOut,
        conflicts: counters.conflicts,
        idempotency: counters.idempotency ?? undefined,
        errorCode: errorCode ?? undefined,
        tenantId,
      });

      // DB: fire-and-forget. The service swallows its own errors.
      void this.logs.record({
        requestId,
        tenantId,
        agentId: req.agentId ?? null,
        operation,
        statusCode,
        startedAt,
        durationMs,
        recordsIn: counters.recordsIn,
        recordsOut: counters.recordsOut,
        conflicts: counters.conflicts,
        errors,
        idempotency: counters.idempotency,
        schemaVersion: headerString(req, 'x-schema-version'),
        errorCode,
      });
    });

    return next.handle().pipe(
      tap({
        next: (value) => { data = value; },
        error: (e) => { err = e; },
      }),
    );
  }
}

/**
 * Maps a request to the operation it represents, or null if the route
 * is not a /sync/* route we instrument. Uses the Nest route pattern
 * (e.g. "/sync/conflicts/:id/resolve"), not the raw URL.
 */
export function classifyOperation(req: RequestLike): SyncOperation | null {
  const method = (req.method ?? '').toUpperCase();
  const route = req.route?.path;
  if (typeof route !== 'string') return null;

  if (route === '/sync/pull' && method === 'POST') return 'pull';
  if (route === '/sync/push' && method === 'POST') return 'push';
  if (route === '/sync/conflicts' && method === 'GET') return 'list_conflicts';
  if (route === '/sync/conflicts/:id/resolve' && method === 'POST') return 'resolve_conflict';
  return null;
}

function headerString(req: RequestLike, name: string): string | null {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

function countBuckets(obj: unknown): number {
  if (typeof obj !== 'object' || obj === null) return 0;
  const o = obj as Record<string, unknown>;
  let n = 0;
  if (Array.isArray(o.created)) n += o.created.length;
  if (Array.isArray(o.updated)) n += o.updated.length;
  if (Array.isArray(o.deleted)) n += o.deleted.length;
  return n;
}

function extractCounters(
  operation: SyncOperation,
  data: unknown,
  req: RequestLike,
): ExtractedCounters {
  const base: ExtractedCounters = { recordsIn: 0, recordsOut: 0, conflicts: 0, idempotency: null };

  switch (operation) {
    case 'pull': {
      const changes = (data as any)?.changes ?? {};
      const out =
        countBuckets(changes.check_ins) +
        countBuckets(changes.missions) +
        countBuckets(changes.sites);
      return { ...base, recordsOut: out };
    }

    case 'push': {
      const body = req.body as any;
      const ci = body?.changes?.check_ins ?? {};
      const recordsIn =
        (ci.created?.length ?? 0) + (ci.updated?.length ?? 0) + (ci.deleted?.length ?? 0);

      const applied = (data as any)?.applied ?? {};
      const recordsOut =
        (applied.created ?? 0) + (applied.updated ?? 0) + (applied.deleted ?? 0);
      const conflicts = Array.isArray((data as any)?.conflicts)
        ? (data as any).conflicts.length
        : 0;

      // idempotency is only meaningful when the client sent the header.
      const hasKey = headerString(req, 'idempotency-key') !== null;
      let idempotency: ExtractedCounters['idempotency'] = null;
      if (hasKey) {
        idempotency = (data as any)?.[IDEMPOTENCY_REPLAY] === true ? 'hit' : 'miss';
      }

      return { recordsIn, recordsOut, conflicts, idempotency };
    }

    case 'list_conflicts': {
      const arr = Array.isArray(data) ? data : [];
      return { ...base, recordsOut: arr.length };
    }

    case 'resolve_conflict':
      return base;
  }
}

function extractErrorCode(err: unknown): string | null {
  if (!(err instanceof HttpException)) return null;
  const resp = err.getResponse();
  if (typeof resp === 'object' && resp !== null && 'code' in resp) {
    const code = (resp as Record<string, unknown>).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}
