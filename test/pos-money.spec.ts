import { describe, expect, it } from 'vitest';
import { convertMoney, roundHalfUp, sumSubtotalsByCurrency, validateProductPrice } from '../src/pos/money.js';

const rate = { cdfPerUsd: 2850 };

describe('POS exact money arithmetic', () => {
  it('converts CDF francs to USD cents with half-up rounding', () => {
    expect(convertMoney(10_000, 'CDF', 'USD', rate)).toBe(351);
    expect(convertMoney(1, 'CDF', 'USD', rate)).toBe(0);
    expect(convertMoney(15, 'CDF', 'USD', { cdfPerUsd: 3000 })).toBe(1);
  });
  it('converts USD cents to CDF francs with half-up rounding', () => {
    expect(convertMoney(125, 'USD', 'CDF', rate)).toBe(3563);
    expect(convertMoney(1, 'USD', 'CDF', rate)).toBe(29);
    expect(convertMoney(1, 'USD', 'CDF', { cdfPerUsd: 250 })).toBe(3);
  });
  it('does not convert when currencies are identical', () => {
    expect(convertMoney(123, 'CDF', 'CDF', rate)).toBe(123);
    expect(convertMoney(123, 'USD', 'USD', rate)).toBe(123);
  });
  it('uses commercial half-up for positive and negative exact halves', () => {
    expect(roundHalfUp(5n, 2n)).toBe(3n);
    expect(roundHalfUp(-5n, 2n)).toBe(-3n);
    expect(roundHalfUp(4n, 2n)).toBe(2n);
    expect(roundHalfUp(-4n, 2n)).toBe(-2n);
  });
  it('keeps mixed basket subtotals separate', () => {
    expect(sumSubtotalsByCurrency([
      { currency: 'CDF', amount: 20_000 }, { currency: 'USD', amount: 550 },
      { currency: 'USD', amount: 675 }, { currency: 'CDF', amount: 8_000 },
    ])).toEqual({ CDF: 28_000, USD: 1225 });
  });
  it('supports mirror-void negative lines without mixing currencies', () => {
    expect(sumSubtotalsByCurrency([
      { currency: 'CDF', amount: -20_000 }, { currency: 'USD', amount: -1225 },
    ])).toEqual({ CDF: -20_000, USD: -1225 });
  });
  it('rejects invalid product prices and currencies', () => {
    expect(validateProductPrice({ currency: 'CDF', amount: 1000 })).toEqual({ currency: 'CDF', amount: 1000 });
    expect(() => validateProductPrice({ currency: 'CDF', amount: 1.5 })).toThrow();
    expect(() => validateProductPrice({ currency: 'USD', amount: -1 })).toThrow();
    expect(() => validateProductPrice({ currency: 'EUR' as any, amount: 100 })).toThrow();
  });
  it('rejects invalid exchange rates and unsafe amounts', () => {
    expect(() => convertMoney(100, 'USD', 'CDF', { cdfPerUsd: 0 })).toThrow();
    expect(() => convertMoney(100, 'USD', 'CDF', { cdfPerUsd: 1.5 })).toThrow();
    expect(() => convertMoney(Number.MAX_SAFE_INTEGER + 1, 'CDF', 'USD', rate)).toThrow();
  });
  it('does not silently overflow an aggregate subtotal', () => {
    expect(() => sumSubtotalsByCurrency([
      { currency: 'CDF', amount: Number.MAX_SAFE_INTEGER }, { currency: 'CDF', amount: 1 },
    ])).toThrow(/safe integer range/);
  });
});
