/**
 * Exact money primitives shared by every POS client contract.
 * CDF amounts are whole francs. USD amounts are integer cents.
 * Exchange rates are integer CDF per 1 USD. Never use floating-point arithmetic.
 */
export const CURRENCIES = ['CDF', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export interface Money { currency: Currency; amount: number; }
export interface ExchangeRate { cdfPerUsd: number; }

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer`);
}
function assertCurrency(currency: string): asserts currency is Currency {
  if (currency !== 'CDF' && currency !== 'USD') throw new TypeError('currency must be CDF or USD');
}
function assertRate(rate: ExchangeRate): void {
  if (!Number.isSafeInteger(rate.cdfPerUsd) || rate.cdfPerUsd <= 0) {
    throw new RangeError('cdfPerUsd must be a positive safe integer');
  }
}

/** Exact commercial half-up rounding; exact halves are rounded away from zero. */
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  if ((absolute % denominator) * 2n >= denominator) quotient += 1n;
  return negative ? -quotient : quotient;
}
function toSafeNumber(value: bigint, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} exceeds safe integer range`);
  return result;
}

/**
 * USD cents -> CDF francs: roundHalfUp(cents * rate / 100).
 * CDF francs -> USD cents: roundHalfUp(francs * 100 / rate).
 */
export function convertMoney(amount: number, from: Currency, to: Currency, rate: ExchangeRate): number {
  assertSafeInteger(amount, 'amount');
  assertCurrency(from);
  assertCurrency(to);
  assertRate(rate);
  if (from === to || amount === 0) return amount;
  if (from === 'USD' && to === 'CDF') {
    return toSafeNumber(roundHalfUp(BigInt(amount) * BigInt(rate.cdfPerUsd), 100n), 'CDF amount');
  }
  return toSafeNumber(roundHalfUp(BigInt(amount) * 100n, BigInt(rate.cdfPerUsd)), 'USD cents');
}

/** Sums integer line amounts while keeping the two currencies independent. */
export function sumSubtotalsByCurrency(lines: readonly Money[]): Record<Currency, number> {
  let cdf = 0n;
  let usd = 0n;
  for (const line of lines) {
    assertCurrency(line.currency);
    assertSafeInteger(line.amount, 'line amount');
    if (line.currency === 'CDF') cdf += BigInt(line.amount);
    else usd += BigInt(line.amount);
  }
  return { CDF: toSafeNumber(cdf, 'CDF subtotal'), USD: toSafeNumber(usd, 'USD subtotal') };
}

/** Validates the canonical integer representation of a product price. */
export function validateProductPrice(price: Money): Money {
  assertCurrency(price.currency);
  assertSafeInteger(price.amount, 'price');
  if (price.amount < 0) throw new RangeError('price must be non-negative');
  return { currency: price.currency, amount: price.amount };
}
