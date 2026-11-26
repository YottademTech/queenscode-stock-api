import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DETAIL_FIELDS, parseDetailTexts, parseProductDetails, type DetailKey, type ProductDetails } from '../catalog/details.ts';
import { makeProductCode, matchProductByName, uniqueProductName } from '../catalog/names.ts';
import { mirrorProducts, type ProductRow } from '../catalog/products.ts';
import type { Queryable } from '../db/client.ts';
import { locations, photoCounts, products } from '../db/schema.ts';
import { lockCatalog, writeOnce, type SaveResult } from '../db/writes.ts';
import type { Deps } from '../deps.ts';
import { AppError } from '../errors.ts';
import { isRecord } from '../lib/text.ts';
import { oneOf, optionalText, requestIdOf, requiredText, wholeNumber } from '../lib/validate.ts';
import { locationNamed, type ShopContext } from '../shop/context.ts';

export const CONFIDENCE_LEVELS = ['High', 'Medium', 'Low'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];
export const MAX_ROWS_PER_SAVE = 60;

/** One reviewed row of a count: a listed product by its code, or a new product by its details. */
export type CountRow = {
  productCode: string | null;
  newProduct: ProductDetails | null;
  /** Details read from the photos of a listed product, to complete its record. */
  details: ProductDetails | null;
  fullCartons: number;
  packSize: number | null;
  loosePieces: number;
  confidence: Confidence;
  note: string;
};

/** What the plan needs to know of a product already in the list. */
type Known = { id: string | null; code: string; name: string; size: string; packSize: number | null };
type NewProduct = ProductDetails & { code: string; packSize: number | null };

/**
 * Saves counts the counter has reviewed. Products Claude did not recognise are created, once even
 * when several rows show the same new product, and details read from the photos fill the empty
 * fields of listed products. All of it is one transaction: either every row is saved or none is.
 */
export async function saveCounts(deps: Deps, shop: ShopContext, request: Record<string, unknown>): Promise<SaveResult> {
  const location = locationNamed(shop, oneOf(request.location, 'location', shop.locations.map((place) => place.name)));
  const counter = requiredText(request.counter, 'counter name', 40);
  const rows = parseCountRows(request.rows);
  const requestId = requestIdOf(request);

  return writeOnce(deps.db, request, async (tx) => {
    const addsProducts = rows.some((row) => row.productCode === null);
    if (addsProducts) await lockCatalog(tx, shop.id);

    const codes = [...new Set(rows.flatMap((row) => (row.productCode ? [row.productCode] : [])))];
    const listedQuery = tx.select().from(products)
      .where(and(eq(products.shopId, shop.id), isNull(products.deletedAt), inArray(products.code, codes)))
      // Always locked in the same order, so two saves can never wait on each other.
      .orderBy(asc(products.id));
    // A product is only locked when this save may write to it. Plain counts of listed products
    // lock nothing, so any number of phones can save them at once.
    const fillsDetails = rows.some((row) => row.productCode !== null && row.details !== null);
    const listed = codes.length === 0 ? [] : fillsDetails ? await listedQuery.for('update') : await listedQuery;
    const catalog = addsProducts ? await knownProducts(tx, shop.id) : [];

    // Everything that can refuse the save is decided before the first write.
    const plan = planCountWrite(listed, catalog, rows);

    const idByCode = new Map<string, string>();
    for (const product of listed) idByCode.set(product.code, product.id);
    for (const product of catalog) if (product.id) idByCode.set(product.code, product.id);

    if (plan.newProducts.length > 0) {
      const created = await tx.insert(products)
        .values(plan.newProducts.map((product) => ({ ...product, shopId: shop.id })))
        .returning({ id: products.id, code: products.code });
      for (const product of created) idByCode.set(product.code, product.id);
    }
    for (const [productId, fill] of plan.fills) {
      await tx.update(products).set({ ...fill, version: sql`${products.version} + 1`, updatedAt: sql`now()` }).where(eq(products.id, productId));
    }
    const changed = [...plan.newProducts.map((product) => idByCode.get(product.code) as string), ...plan.fills.keys()];
    await mirrorProducts(deps, tx, shop.id, changed);

    await tx.insert(photoCounts).values(plan.counts.map((count) => ({
      stocktakeId: shop.stocktake.id,
      locationId: location.id,
      productId: idByCode.get(count.code) as string,
      fullCartons: count.fullCartons,
      packSize: count.packSize,
      loosePieces: count.loosePieces,
      confidence: count.confidence,
      note: count.note,
      counter,
      requestId,
    })));
    await deps.mirror.enqueue(tx, {
      kind: 'counts', countDate: shop.stocktake.countDate, location: location.name, counter, rows: plan.counts,
    });
  });
}

async function knownProducts(db: Queryable, shopId: string): Promise<Known[]> {
  return db.select({ id: products.id, code: products.code, name: products.name, size: products.size, packSize: products.packSize })
    .from(products).where(and(eq(products.shopId, shopId), isNull(products.deletedAt)));
}

/**
 * Turns reviewed rows into what to write: the products to create, the details to fill in and the
 * count rows. `listed` are the products the rows name by code; `catalog` is every product, needed
 * only when a row brings a product without a code. Pure: it reads and writes nothing.
 */
export function planCountWrite(listed: readonly ProductRow[], catalog: readonly Known[], rows: readonly CountRow[]) {
  // Copies, because a detail filled by one row must count as filled for the rows after it.
  const byCode = new Map(listed.map((product) => [product.code, { ...product }]));
  const known = [...catalog];
  const newProducts: NewProduct[] = [];
  const fills = new Map<string, Partial<ProductDetails>>();

  const counts = rows.map((row, index) => {
    const label = `Row ${index + 1}`;
    let product: { code: string; packSize: number | null };

    if (row.productCode) {
      const found = byCode.get(row.productCode);
      if (!found) throw new AppError('invalid_request', `${label}: that product is no longer in the list. Reload the app.`);
      fillEmptyDetails(found, row.details, fills);
      product = found;
    } else {
      const details = row.newProduct as ProductDetails;
      let match = matchProductByName(known, details);
      if (!match) {
        match = {
          id: null,
          name: uniqueProductName(known, details),
          code: makeProductCode(details.name, details.size, known.map((candidate) => candidate.code)),
          size: details.size,
          packSize: row.packSize,
        };
        known.push(match);
        newProducts.push({ ...details, name: match.name, code: match.code, packSize: row.packSize });
      }
      product = match;
    }

    // Without a pack size, full bags, sacks and cartons would count as zero pieces.
    if (row.fullCartons > 0 && !row.packSize && !product.packSize) {
      throw new AppError('invalid_request', `${label}: enter how many pieces are in each bag, sack or carton.`);
    }
    return {
      code: product.code,
      fullCartons: row.fullCartons,
      packSize: row.packSize,
      loosePieces: row.loosePieces,
      confidence: row.confidence,
      note: row.note,
    };
  });

  return { newProducts, fills, counts };
}

/**
 * Details read from the photos complete a listed product's record. Only empty fields are filled,
 * so nothing a person entered is replaced, and the name is never touched. A Low-confidence row
 * fills too: Low is usually about the count, and the counter has confirmed the product before saving.
 */
function fillEmptyDetails(product: ProductRow, details: ProductDetails | null, fills: Map<string, Partial<ProductDetails>>): void {
  if (!details) return;
  for (const field of DETAIL_FIELDS) {
    const key: DetailKey = field.key;
    const value = details[key];
    if (key === 'name' || product[key] !== '' || value === '') continue;
    product[key] = value;
    fills.set(product.id, { ...fills.get(product.id), [key]: value });
  }
}

function parseCountRows(rows: unknown): CountRow[] {
  if (!Array.isArray(rows) || rows.length === 0) throw new AppError('invalid_request', 'There are no rows to save.');
  if (rows.length > MAX_ROWS_PER_SAVE) {
    throw new AppError('invalid_request', `Save at most ${MAX_ROWS_PER_SAVE} rows at a time.`);
  }
  return rows.map((row: unknown, index) => {
    const label = `Row ${index + 1}`;
    if (!isRecord(row)) throw new AppError('invalid_request', `${label} is not valid.`);

    const hasCode = typeof row.productCode === 'string' && row.productCode !== '';
    return {
      productCode: hasCode ? requiredText(row.productCode, `${label} product`, 60) : null,
      newProduct: hasCode ? null : parseProductDetails(row.newProduct, `${label} new product`),
      details: hasCode && row.details !== undefined && row.details !== null ? parseDetailTexts(row.details, `${label} details`) : null,
      fullCartons: wholeNumber(row.fullCartons, `${label} full cartons`),
      packSize: row.packSize === null || row.packSize === undefined ? null : wholeNumber(row.packSize, `${label} pack size`) || null,
      loosePieces: wholeNumber(row.loosePieces, `${label} loose pieces`),
      confidence: oneOf(row.confidence, `${label} confidence`, CONFIDENCE_LEVELS),
      note: optionalText(row.note, `${label} note`, 300),
    };
  });
}

/** Pieces counted by photo so far in the open stocktake, by product and place. */
export async function countedSoFar(db: Queryable, shop: ShopContext): Promise<{ code: string; location: string; pieces: number }[]> {
  const pieces = sql<number>`sum(${photoCounts.fullCartons} * coalesce(${photoCounts.packSize}, ${products.packSize}, 0) + ${photoCounts.loosePieces})::int`;
  return db.select({ code: products.code, location: locations.name, pieces }).from(photoCounts)
    .innerJoin(products, eq(products.id, photoCounts.productId))
    .innerJoin(locations, eq(locations.id, photoCounts.locationId))
    .where(and(eq(photoCounts.stocktakeId, shop.stocktake.id), isNull(products.deletedAt)))
    .groupBy(products.code, locations.name);
}
