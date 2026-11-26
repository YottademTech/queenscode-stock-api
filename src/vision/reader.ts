import { sql } from 'drizzle-orm';
import { DETAIL_FIELDS, type DetailField, type ProductDetails } from '../catalog/details.ts';
import type { Database } from '../db/client.ts';
import { products } from '../db/schema.ts';
import type { Deps } from '../deps.ts';
import { AppError } from '../errors.ts';
import { barcodeChecks, clip, clipLines, isDayOrMonth, isRecord } from '../lib/text.ts';
import { MAX_QUANTITY, oneOf } from '../lib/validate.ts';
import { parseImage, type EncodedImage } from '../photos/store.ts';
import type { ShopContext } from '../shop/context.ts';
import { CONFIDENCE_LEVELS, MAX_ROWS_PER_SAVE, type Confidence } from '../stocktake/counts.ts';
import { COUNT_INSTRUCTIONS, DETAIL_PHOTOS_GUIDE, LABEL_INSTRUCTIONS, VIEWS_DETAIL_PHOTOS_GUIDE, VIEWS_GUIDE } from './prompts.ts';

// Reading photos. Nothing is saved here: the counter reviews every row first.

/** One count photo plus detail photos (front, back, markings) that Claude reads in the same request. */
export const MAX_PHOTOS_PER_COUNT = 4;
/**
 * Views of the same stock that one count may hold: the moments the app keeps from a video taken
 * around it. They take the place of the one count photo; the detail photos come after them.
 */
export const MAX_COUNT_VIEWS = 8;

const DETAIL_PROPERTIES: Record<string, unknown> = {
  ...Object.fromEntries(DETAIL_FIELDS.filter((field) => field.readFromPhoto).map((field) => [field.key, { type: 'string' }])),
  otherDetails: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'value'],
      properties: { label: { type: 'string' }, value: { type: 'string' } },
    },
  },
};

const COUNT_ITEM_PROPERTIES = {
  ...DETAIL_PROPERTIES,
  productCode: { type: 'string' },
  fullCartons: { type: 'integer' },
  packSize: { type: 'integer' },
  loosePieces: { type: 'integer' },
  confidence: { type: 'string', enum: CONFIDENCE_LEVELS },
  note: { type: 'string' },
};

const COUNT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'photoNote'],
  properties: {
    photoNote: { type: 'string' },
    items: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: Object.keys(COUNT_ITEM_PROPERTIES), properties: COUNT_ITEM_PROPERTIES },
    },
  },
};

const LABEL_PROPERTIES = { ...DETAIL_PROPERTIES, note: { type: 'string' } };
const LABEL_SCHEMA = { type: 'object', additionalProperties: false, required: Object.keys(LABEL_PROPERTIES), properties: LABEL_PROPERTIES };

export type CountedItem = ProductDetails & {
  productCode: string | null;
  fullCartons: number;
  packSize: number | null;
  loosePieces: number;
  confidence: Confidence;
  note: string;
};

export async function analyzeCount(deps: Deps, shop: ShopContext, request: Record<string, unknown>): Promise<{ items: CountedItem[]; photoNote: string }> {
  const location = oneOf(request.location, 'location', shop.locations.map((place) => place.name));
  const { images, views } = parseCountImages(request);
  const listed = await deps.db.select({ code: products.code, name: products.name, size: products.size }).from(products)
    .where(sql`${products.shopId} = ${shop.id} and ${products.deletedAt} is null`).orderBy(products.createdAt, products.code);

  await claimClaudeCall(deps.db, deps.config.CLAUDE_DAILY_CALL_LIMIT);
  const answer = await deps.vision.ask({
    instructions: COUNT_INSTRUCTIONS,
    question: countQuestion(location, listed, views, images.length - views),
    images,
    views,
    schema: COUNT_SCHEMA,
    effort: 'high',
  });
  return cleanCountAnswer(answer, listed.map((product) => product.code));
}

export async function readProductLabel(deps: Deps, _shop: ShopContext, request: Record<string, unknown>): Promise<ProductDetails & { note: string }> {
  const image = parseImage(request.image);

  await claimClaudeCall(deps.db, deps.config.CLAUDE_DAILY_CALL_LIMIT);
  const answer = await deps.vision.ask({
    instructions: LABEL_INSTRUCTIONS,
    question: 'Read this product photo.',
    images: [image],
    views: 1,
    schema: LABEL_SCHEMA,
    effort: 'medium',
  });
  if (!isRecord(answer)) throw new AppError('claude_unavailable', 'The photo could not be read this time. Try the photo again.');
  return { ...cleanDetails(answer), note: clip(answer.note, 300) };
}

/** `views` is how many of the photos show the stock to count; `detailPhotoCount` how many close-ups follow them. */
function countQuestion(location: string, listed: readonly { code: string; name: string; size: string }[], views: number, detailPhotoCount: number): string {
  const list = listed.length === 0
    ? '(empty: every product is unknown)'
    : listed.map((product) => [product.code, product.name, product.size || 'size unknown'].join(' | ')).join('\n');
  return `Location: ${location}\n\nProduct list:\n${list}\n\n${countTask(views, detailPhotoCount)}`;
}

function countTask(views: number, detailPhotoCount: number): string {
  if (views > 1) {
    const counted = `Count the stock shown in views 1 to ${views}`;
    return detailPhotoCount === 0
      ? `${VIEWS_GUIDE}\n\n${counted}.`
      : `${VIEWS_GUIDE}\n\n${VIEWS_DETAIL_PHOTOS_GUIDE}\n\n${counted} and record the details shown in the ${detailPhotoCount === 1 ? 'detail photo.' : `${detailPhotoCount} detail photos.`}`;
  }
  return detailPhotoCount === 0
    ? 'Count the stock in this photo.'
    : `${DETAIL_PHOTOS_GUIDE}\n\nCount the stock in photo 1 and record the details shown in all ${detailPhotoCount + 1} photos.`;
}

/** Claude's answer is untrusted input: codes are checked against the list and numbers are bounded. */
function cleanCountAnswer(answer: unknown, knownCodes: readonly string[]): { items: CountedItem[]; photoNote: string } {
  if (!isRecord(answer) || !Array.isArray(answer.items)) {
    throw new AppError('claude_unavailable', 'The photo could not be read this time. Try the photo again.');
  }
  const items = answer.items.filter(isRecord).slice(0, MAX_ROWS_PER_SAVE).map((item): CountedItem => {
    const code = String(item.productCode || '').trim();
    return {
      ...cleanDetails(item),
      productCode: knownCodes.includes(code) ? code : null,
      fullCartons: cleanCount(item.fullCartons),
      packSize: cleanCount(item.packSize) || null,
      loosePieces: cleanCount(item.loosePieces),
      confidence: CONFIDENCE_LEVELS.includes(item.confidence as Confidence) ? (item.confidence as Confidence) : 'Low',
      note: clip(item.note, 300),
    };
  });
  return { items, photoNote: clip(answer.photoNote, 300) };
}

/** Claude's reading of a label is untrusted input: every field is bounded and badly formed ones are dropped. */
function cleanDetails(source: Record<string, unknown>): ProductDetails {
  const details = {} as ProductDetails;
  for (const field of DETAIL_FIELDS) {
    const raw = field.key === 'otherDetails' ? detailLines(source.otherDetails) : source[field.key];
    details[field.key] = field.readFromPhoto ? cleanDetail(field, raw) : '';
  }
  return details;
}

function cleanDetail(field: DetailField, raw: unknown): string {
  if (field.kind === 'lines') return clipLines(raw, field.max);
  if (field.kind === 'digits') {
    const digits = String(raw || '').replace(/\D/g, '');
    // A misread barcode would look real in the list, so a standard one must pass its check digit.
    return digits.length > field.max || !barcodeChecks(digits) ? '' : digits;
  }
  if (field.kind === 'date') {
    const text = String(raw || '').trim();
    return isDayOrMonth(text) ? text : '';
  }
  return clip(raw, field.max);
}

/** Turns Claude's label and value pairs into "Label: value" lines, the form kept in one field. */
function detailLines(pairs: unknown): string {
  if (!Array.isArray(pairs)) return '';
  return pairs.filter(isRecord)
    .map((pair) => ({ label: clip(pair.label, 60), value: clip(pair.value, 400) }))
    .filter((pair) => pair.value !== '')
    .map((pair) => (pair.label ? `${pair.label}: ${pair.value}` : pair.value))
    .join('\n');
}

function cleanCount(value: unknown): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(number, MAX_QUANTITY) : 0;
}

/**
 * The photos of a count: the stock, optionally followed by detail photos. The stock is one photo,
 * or `countViews` views of it from a video taken around it. An older app sends one `image`, or
 * `images` without `countViews`.
 */
function parseCountImages(request: Record<string, unknown>): { images: EncodedImage[]; views: number } {
  if (request.images === undefined || request.images === null) return { images: [parseImage(request.image)], views: 1 };

  const views = request.countViews === undefined || request.countViews === null ? 1 : request.countViews;
  if (typeof views !== 'number' || !Number.isInteger(views) || views < 1 || views > MAX_COUNT_VIEWS) {
    throw new AppError('invalid_request', `A count takes 1 to ${MAX_COUNT_VIEWS} views of the stock.`);
  }
  const mostDetails = MAX_PHOTOS_PER_COUNT - 1;
  if (!Array.isArray(request.images) || request.images.length < views || request.images.length > views + mostDetails) {
    throw new AppError('invalid_request', views === 1
      ? `Send 1 to ${MAX_PHOTOS_PER_COUNT} photos: one to count and up to ${mostDetails} for details.`
      : `Send the ${views} views of the stock, and up to ${mostDetails} photos for details.`);
  }
  return { images: request.images.map(parseImage), views };
}

/**
 * Counts this call against today's limit, in one statement, so any number of phones asking at the
 * same moment are counted exactly. Refuses once the limit is reached.
 */
async function claimClaudeCall(db: Database, dailyLimit: number): Promise<void> {
  const claimed = await db.execute(sql`
    insert into claude_usage (day, calls) values ((now() at time zone 'utc')::date, 1)
    on conflict (day) do update set calls = claude_usage.calls + 1 where claude_usage.calls < ${dailyLimit}
    returning calls
  `) as unknown as unknown[];
  if (claimed.length === 0) {
    throw new AppError('limit_reached', `Today's photo limit (${dailyLimit}) is used up. Count by hand, or try tomorrow.`);
  }
}
