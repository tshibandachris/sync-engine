export type SyncOperation = 'pull' | 'push' | 'list_conflicts' | 'resolve_conflict';

export interface SyncCallMetrics {
  operation: SyncOperation;
  statusCode: number;
  durationMs: number;
  recordsIn: number;
  recordsOut: number;
  conflicts: number;
  idempotency?: 'hit' | 'miss';
  errorCode?: string;
  tenantId: string;
}
