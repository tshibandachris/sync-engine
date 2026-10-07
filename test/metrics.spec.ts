import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordSyncCall, renderMetrics, resetMetrics } from '../src/observability/metrics.js';
import { createMetricsServer, isAuthorized } from '../src/observability/metrics-server.js';
import type { SyncCallMetrics } from '../src/observability/metrics.types.js';

const call = (over: Partial<SyncCallMetrics> = {}): SyncCallMetrics => ({
  operation: 'pull',
  statusCode: 201,
  durationMs: 12,
  recordsIn: 0,
  recordsOut: 0,
  conflicts: 0,
  tenantId: 'tenant-1',
  ...over,
});

// Lit la valeur d'un échantillon, quel que soit l'ordre des labels.
function sample(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  for (const line of text.split('\n')) {
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const found: Record<string, string> = {};
    for (const l of (m[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)) found[l[1]] = l[2];
    const keys = Object.keys(labels);
    if (keys.length === Object.keys(found).length && keys.every((k) => found[k] === labels[k])) {
      return Number(m[3]);
    }
  }
  return undefined;
}

describe('recordSyncCall', () => {
  beforeEach(() => resetMetrics());

  it('incrémente sync_requests_total par opération et statut', async () => {
    recordSyncCall(call());
    const out = await renderMetrics();
    expect(sample(out, 'sync_requests_total', { operation: 'pull', status: '201' })).toBe(1);
  });

  it('alimente les compteurs de records, de conflits et la latence', async () => {
    recordSyncCall(call({ operation: 'push', recordsIn: 7, recordsOut: 3, conflicts: 2, durationMs: 250 }));
    const out = await renderMetrics();
    expect(sample(out, 'sync_records_total', { direction: 'in' })).toBe(7);
    expect(sample(out, 'sync_records_total', { direction: 'out' })).toBe(3);
    expect(sample(out, 'sync_conflicts_total')).toBe(2);
    expect(sample(out, 'sync_request_duration_seconds_count', { operation: 'push' })).toBe(1);
    expect(sample(out, 'sync_request_duration_seconds_sum', { operation: 'push' })).toBeCloseTo(0.25);
    expect(sample(out, 'sync_payload_records_count', { direction: 'in' })).toBe(1);
  });

  it("compte les hits et misses d'idempotency, et rien sans le champ", async () => {
    recordSyncCall(call({ operation: 'push', idempotency: 'hit' }));
    recordSyncCall(call({ operation: 'push', idempotency: 'miss' }));
    recordSyncCall(call({ operation: 'pull' }));
    const out = await renderMetrics();
    expect(sample(out, 'sync_idempotency_total', { result: 'hit' })).toBe(1);
    expect(sample(out, 'sync_idempotency_total', { result: 'miss' })).toBe(1);
  });

  it('un 410 incrémente sync_stale_cursor_total par tenant, et seulement un 410', async () => {
    recordSyncCall(call({ statusCode: 410, tenantId: 'tenant-a' }));
    recordSyncCall(call({ statusCode: 410, tenantId: 'tenant-a' }));
    recordSyncCall(call({ statusCode: 201, tenantId: 'tenant-b' }));
    const out = await renderMetrics();
    expect(sample(out, 'sync_stale_cursor_total', { tenant_id: 'tenant-a' })).toBe(2);
    expect(sample(out, 'sync_stale_cursor_total', { tenant_id: 'tenant-b' })).toBeUndefined();
  });

  it("n'ajoute jamais tenant_id à la latence (cardinalité)", async () => {
    recordSyncCall(call({ tenantId: 'tenant-x' }));
    const out = await renderMetrics();
    expect(out).not.toMatch(/sync_request_duration_seconds[^\n]*tenant_id/);
  });

  it('ne lève pas sur des valeurs invalides', () => {
    expect(() =>
      recordSyncCall(call({ durationMs: Number.NaN, recordsIn: -5, recordsOut: Infinity, conflicts: -1 })),
    ).not.toThrow();
  });
});

describe('renderMetrics', () => {
  it('produit le format Prometheus attendu', async () => {
    const out = await renderMetrics();
    expect(out).toContain('# HELP sync_requests_total');
    expect(out).toContain('# TYPE sync_requests_total counter');
    expect(out).toContain('# TYPE sync_request_duration_seconds histogram');
  });
});

describe('serveur /metrics', () => {
  const TOKEN = 'a'.repeat(40);
  const server = createMetricsServer(TOKEN);
  let base = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('401 sans token', async () => {
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
  });

  it('401 avec un mauvais token, de même longueur ou non', async () => {
    for (const bad of ['b'.repeat(40), 'court']) {
      const res = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${bad}` } });
      expect(res.status).toBe(401);
    }
  });

  it('200 avec le bon token, au format Prometheus', async () => {
    const res = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('# TYPE sync_requests_total counter');
  });

  it('404 hors /metrics, 405 hors GET', async () => {
    expect((await fetch(`${base}/autre`)).status).toBe(404);
    const post = await fetch(`${base}/metrics`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(post.status).toBe(405);
  });

  it('isAuthorized rejette un en-tête mal formé', () => {
    expect(isAuthorized(undefined, TOKEN)).toBe(false);
    expect(isAuthorized(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });
});
