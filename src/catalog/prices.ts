import { asc } from 'drizzle-orm';
import type { Queryable } from '../db/client.ts';
import { currencies } from '../db/schema.ts';
import { AppError } from '../errors.ts';
import { isRecord } from '../lib/text.ts';

export type Currency = { code: string; name: string; shortName: string; decimals: number };

/** A price as stored: whole minor units (pesewas) and its currency, or nothing. */
export type StoredPrice = { priceMinor: number; currencyCode: string } | { priceMinor: null; currencyCode: null };

/** The shop's own currency: a price with no currency given is in Ghana cedis. */
export const DEFAULT_CURRENCY = 'GHS';
const MAX_PRICE = 1_000_000_000;

/** The currencies a price can be in when nothing else was set up. */
export const DEFAULT_CURRENCIES: readonly Currency[] = [
  { code: 'GHS', name: 'Ghana cedi', shortName: 'GH₵', decimals: 2 },
  { code: 'USD', name: 'US dollar', shortName: 'US$', decimals: 2 },
  { code: 'EUR', name: 'Euro', shortName: '€', decimals: 2 },
  { code: 'GBP', name: 'Pound sterling', shortName: '£', decimals: 2 },
  { code: 'NGN', name: 'Nigerian naira', shortName: '₦', decimals: 2 },
  { code: 'XOF', name: 'West African CFA franc', shortName: 'CFA', decimals: 0 },
  { code: 'ZAR', name: 'South African rand', shortName: 'R', decimals: 2 },
  { code: 'CNY', name: 'Chinese yuan', shortName: 'CN¥', decimals: 2 },
  { code: 'AED', name: 'UAE dirham', shortName: 'AED', decimals: 2 },
];

export async function listCurrencies(db: Queryable): Promise<Currency[]> {
  // The shop's own currency first, as the app offers them in this order.
  const rows = await db.select().from(currencies).orderBy(asc(currencies.code));
  return [...rows.filter((row) => row.code === DEFAULT_CURRENCY), ...rows.filter((row) => row.code !== DEFAULT_CURRENCY)];
}

/**
 * The price in a request, which the app sends in the currency's major unit (25.50 cedis):
 * undefined when none was sent (keep the stored one), a null price to clear it, else the amount
 * in minor units. An amount with more decimals than the currency has is refused, not rounded.
 */
export function parsePrice(source: unknown, known: readonly Currency[]): StoredPrice | undefined {
  if (!isRecord(source) || source.price === undefined) return undefined;
  if (source.price === null) return { priceMinor: null, currencyCode: null };

  const code = source.currency === undefined || source.currency === null || source.currency === '' ? DEFAULT_CURRENCY : source.currency;
  const currency = known.find((candidate) => candidate.code === code);
  if (!currency) throw new AppError('invalid_request', 'Choose the currency of the price.');

  const amount = source.price;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > MAX_PRICE) {
    throw new AppError('invalid_request', `The price must be a number from 0 to ${MAX_PRICE}.`);
  }
  const scale = 10 ** currency.decimals;
  const minor = Math.round(amount * scale);
  if (Math.abs(minor / scale - amount) > 1e-9) {
    throw new AppError('invalid_request', currency.decimals === 0
      ? `A price in ${currency.code} has no decimals.`
      : `A price in ${currency.code} has at most ${currency.decimals} decimals.`);
  }
  return { priceMinor: minor, currencyCode: currency.code };
}

/** A stored price in the currency's major unit, as the app shows it. */
export function majorUnits(priceMinor: number, decimals: number): number {
  return priceMinor / 10 ** decimals;
}
