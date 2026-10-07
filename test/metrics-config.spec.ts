import { describe, expect, it } from 'vitest';
import { assertMetricsConfig } from '../src/boot-guards.js';

const TOKEN = 'k'.repeat(40);

describe('assertMetricsConfig', () => {
  it('accepte une config valide', () => {
    expect(assertMetricsConfig({ METRICS_PORT: '9464', OPS_METRICS_TOKEN: TOKEN, PORT: '3000' })).toEqual({
      port: 9464,
      token: TOKEN,
    });
  });

  it('exige METRICS_PORT, entier valide', () => {
    expect(() => assertMetricsConfig({ OPS_METRICS_TOKEN: TOKEN })).toThrow(/METRICS_PORT/);
    expect(() => assertMetricsConfig({ METRICS_PORT: 'abc', OPS_METRICS_TOKEN: TOKEN })).toThrow(/METRICS_PORT/);
    expect(() => assertMetricsConfig({ METRICS_PORT: '70000', OPS_METRICS_TOKEN: TOKEN })).toThrow(/METRICS_PORT/);
  });

  it("refuse le port de l'API", () => {
    expect(() => assertMetricsConfig({ METRICS_PORT: '3000', PORT: '3000', OPS_METRICS_TOKEN: TOKEN })).toThrow(
      /différer/,
    );
  });

  it('exige OPS_METRICS_TOKEN de 32 caractères minimum', () => {
    expect(() => assertMetricsConfig({ METRICS_PORT: '9464' })).toThrow(/OPS_METRICS_TOKEN/);
    expect(() => assertMetricsConfig({ METRICS_PORT: '9464', OPS_METRICS_TOKEN: 'k'.repeat(31) })).toThrow(
      /OPS_METRICS_TOKEN/,
    );
    expect(assertMetricsConfig({ METRICS_PORT: '9464', OPS_METRICS_TOKEN: 'k'.repeat(32) }).port).toBe(9464);
  });

  it("refuse la valeur d'exemple de .env.example", () => {
    expect(() =>
      assertMetricsConfig({ METRICS_PORT: '9464', OPS_METRICS_TOKEN: 'change-me-generate-with-openssl-rand-hex-32' }),
    ).toThrow(/exemple/);
  });
});
