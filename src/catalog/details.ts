import { AppError } from '../errors.ts';
import { isDayOrMonth, isRecord } from '../lib/text.ts';
import { optionalLines, optionalText, optionalWholeNumber, requiredText } from '../lib/validate.ts';

/**
 * Every product detail kept as text: its name in requests and in the products table, the words
 * used for it in messages, its length limit and its kind. line = one line of text, lines = several
 * lines, digits and date are checked formats. This one table drives what Claude is asked for, what
 * is validated and what is stored. web/src/api/contract.ts lists the same keys for the app.
 */
export const DETAIL_FIELDS = [
  { key: 'name', label: 'name', max: 120, kind: 'line', readFromPhoto: true },
  { key: 'size', label: 'size', max: 30, kind: 'line', readFromPhoto: true },
  { key: 'barcode', label: 'barcode', max: 20, kind: 'digits', readFromPhoto: true },
  { key: 'category', label: 'category', max: 40, kind: 'line', readFromPhoto: true },
  { key: 'expiry', label: 'expiry date', max: 10, kind: 'date', readFromPhoto: true },
  { key: 'brand', label: 'brand', max: 60, kind: 'line', readFromPhoto: true },
  { key: 'variant', label: 'variant', max: 80, kind: 'line', readFromPhoto: true },
  { key: 'description', label: 'description', max: 600, kind: 'line', readFromPhoto: true },
  { key: 'batchNumber', label: 'batch number', max: 40, kind: 'line', readFromPhoto: true },
  { key: 'manufactureDate', label: 'manufacture date', max: 10, kind: 'date', readFromPhoto: true },
  { key: 'manufacturer', label: 'manufacturer', max: 200, kind: 'line', readFromPhoto: true },
  { key: 'countryOfOrigin', label: 'country of origin', max: 60, kind: 'line', readFromPhoto: true },
  { key: 'ingredients', label: 'ingredients', max: 3000, kind: 'line', readFromPhoto: true },
  { key: 'directions', label: 'directions', max: 1500, kind: 'line', readFromPhoto: true },
  { key: 'otherDetails', label: 'other details', max: 3000, kind: 'lines', readFromPhoto: true },
  { key: 'labelText', label: 'label text', max: 5000, kind: 'lines', readFromPhoto: true },
  // What a QR code on the pack holds. A person types, pastes or scans it in: Claude is not asked
  // for it, because a photo cannot be relied on to decode one and a guessed link would look real.
  { key: 'qrCode', label: 'qr code', max: 2000, kind: 'line', readFromPhoto: false },
] as const;

export type DetailField = (typeof DETAIL_FIELDS)[number];
export type DetailKey = DetailField['key'];
export type ProductDetails = Record<DetailKey, string>;

export type ProductInput = ProductDetails & { code: string | null; packSize: number | null; reorderLevel: number | null };

/** The details as text, each checked against its field's limit and format. Any may be empty. */
export function parseDetailTexts(details: unknown, label: string): ProductDetails {
  if (!isRecord(details)) throw new AppError('invalid_request', `The ${label} details are missing.`);

  const parsed = {} as ProductDetails;
  for (const field of DETAIL_FIELDS) {
    const fieldLabel = `${label} ${field.label}`;
    const text = field.kind === 'lines'
      ? optionalLines(details[field.key], fieldLabel, field.max)
      : optionalText(details[field.key], fieldLabel, field.max);

    if (field.kind === 'digits' && !/^\d*$/.test(text)) {
      throw new AppError('invalid_request', `The ${fieldLabel} must be digits only.`);
    }
    if (field.kind === 'date' && text !== '' && !isDayOrMonth(text)) {
      throw new AppError('invalid_request', `The ${fieldLabel} must be YYYY-MM-DD or YYYY-MM.`);
    }
    parsed[field.key] = text;
  }
  return parsed;
}

/** The details of a product that is being created or edited: the name is required. */
export function parseProductDetails(details: unknown, label: string): ProductDetails {
  const parsed = parseDetailTexts(details, label);
  if (parsed.name === '') throw new AppError('invalid_request', `Enter the ${label} name.`);
  return parsed;
}

export function parseProductInput(product: unknown): ProductInput {
  const details = parseProductDetails(product, 'product');
  const source = product as Record<string, unknown>;
  return {
    ...details,
    code: typeof source.code === 'string' && source.code !== '' ? requiredText(source.code, 'product code', 60) : null,
    packSize: optionalWholeNumber(source.packSize, 'pack size'),
    reorderLevel: optionalWholeNumber(source.reorderLevel, 'reorder level'),
  };
}

export function pickDetails(source: ProductDetails): ProductDetails {
  const details = {} as ProductDetails;
  for (const field of DETAIL_FIELDS) details[field.key] = source[field.key];
  return details;
}
