import { Counter, Histogram, Registry } from 'prom-client';
import type { SyncCallMetrics } from './metrics.types.js';

// Registre dédié : pas de pollution du registre global, et reset possible en test.
const registry = new Registry();

const requestsTotal = new Counter({
  name: 'sync_requests_total',
  help: 'Total /sync/* requests by operation and HTTP status.',
  labelNames: ['operation', 'status'] as const,
  registers: [registry],
});

const requestDuration = new Histogram({
  name: 'sync_request_duration_seconds',
  help: 'Duration of /sync/* requests in seconds, by operation.',
  labelNames: ['operation'] as const,
  registers: [registry],
});

const recordsTotal = new Counter({
  name: 'sync_records_total',
  help: 'Total records received (in) and sent (out) by /sync/*.',
  labelNames: ['direction'] as const,
  registers: [registry],
});

const conflictsTotal = new Counter({
  name: 'sync_conflicts_total',
  help: 'Total conflicts detected by /sync/*.',
  registers: [registry],
});

const idempotencyTotal = new Counter({
  name: 'sync_idempotency_total',
  help: 'Idempotency-Key lookups on /sync/push, by result.',
  labelNames: ['result'] as const,
  registers: [registry],
});

// tenant_id : une série par tenant, voulu pour repérer les tenants bloqués.
// Ne jamais l'ajouter à un histogramme (cardinalité x buckets).
const staleCursorTotal = new Counter({
  name: 'sync_stale_cursor_total',
  help: '410 GONE responses (stale cursor), by tenant.',
  labelNames: ['tenant_id'] as const,
  registers: [registry],
});

const payloadRecords = new Histogram({
  name: 'sync_payload_records',
  help: 'Records per request, by direction.',
  labelNames: ['direction'] as const,
  buckets: [0, 1, 5, 10, 50, 100, 500, 1000, 5000],
  registers: [registry],
});

const nonNegative = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/** N'échoue jamais : l'instrumentation ne doit pas casser une requête de sync. */
export function recordSyncCall(m: SyncCallMetrics): void {
  try {
    requestsTotal.inc({ operation: m.operation, status: String(m.statusCode) });
    requestDuration.observe({ operation: m.operation }, nonNegative(m.durationMs) / 1000);

    const recordsIn = nonNegative(m.recordsIn);
    const recordsOut = nonNegative(m.recordsOut);
    if (recordsIn > 0) recordsTotal.inc({ direction: 'in' }, recordsIn);
    if (recordsOut > 0) recordsTotal.inc({ direction: 'out' }, recordsOut);
    payloadRecords.observe({ direction: 'in' }, recordsIn);
    payloadRecords.observe({ direction: 'out' }, recordsOut);

    const conflicts = nonNegative(m.conflicts);
    if (conflicts > 0) conflictsTotal.inc(conflicts);

    if (m.idempotency) idempotencyTotal.inc({ result: m.idempotency });
    if (m.statusCode === 410) staleCursorTotal.inc({ tenant_id: m.tenantId });
  } catch (err) {
    console.error('[metrics] recordSyncCall failed:', err);
  }
}

export function renderMetrics(): Promise<string> {
  return registry.metrics();
}

export const metricsContentType = registry.contentType;

/** Pour les tests uniquement. */
export function resetMetrics(): void {
  registry.resetMetrics();
}
