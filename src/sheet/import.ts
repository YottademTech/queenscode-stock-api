import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { parseProductDetails } from '../catalog/details.ts';
import { sameName } from '../catalog/names.ts';
import { parsePrice } from '../catalog/prices.ts';
import type { Database } from '../db/client.ts';
import { adjustments, handledRequests, locations, photoCounts, productPhotos, products, sheetOutbox, stocktakes } from '../db/schema.ts';
import { openStocktake, saveCurrencies, saveLocations } from '../shop/setup.ts';
import { ADJUSTMENT_KINDS } from '../stocktake/adjustments.ts';
import { CONFIDENCE_LEVELS } from '../stocktake/counts.ts';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const wholeOrNull = z.number().int().min(0).nullable();

/** What the Apps Script's `exportAll` action returns: the Sheet, row by row. */
export const sheetExportSchema = z.object({
  countDate: day,
  locations: z.array(z.string().min(1)).min(1),
  currencies: z.array(z.object({ code: z.string().length(3), name: z.string(), shortName: z.string(), decimals: z.number().int().min(0).max(3) })),
  products: z.array(z.looseObject({
    code: z.string().min(1), packSize: wholeOrNull, reorderLevel: wholeOrNull,
    imageUrls: z.array(z.string()).default([]), price: z.number().nullable().default(null), currency: z.string().default(''),
  })),
  counts: z.array(z.object({
    countDate: day, location: z.string(), code: z.string(), fullCartons: z.number().int().min(0), packSize: wholeOrNull,
    loosePieces: z.number().int().min(0), confidence: z.enum(CONFIDENCE_LEVELS), note: z.string(),
  })),
  adjustments: z.array(z.object({
    // Empty for stock added or removed by a row typed into the Sheet with no timestamp.
    at: z.union([z.iso.datetime(), z.literal('')]), counter: z.string(), countDate: day, location: z.string(), productName: z.string(),
    type: z.enum(ADJUSTMENT_KINDS), quantity: z.number().int().min(0), reason: z.string(),
  })),
  /** Rows of the Sheet that could not be read out, with the reason. */
  leftOut: z.array(z.object({ tab: z.string(), row: z.number(), why: z.string() })).default([]),
  /** Saves the Apps Script had already written, by the ID the phone gave them. */
  handledRequests: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/), action: z.string() })).default([]),
});
export type SheetExport = z.infer<typeof sheetExportSchema>;

export type ImportSummary = { products: number; counts: number; adjustments: number; skipped: string[] };

/**
 * Starts the database from the Sheet: its places, currencies, products, and every count and hand
 * entry, under the stocktakes they were made in. One transaction: all of it or none.
 *
 * It refuses when the shop already has products, unless `replace` is set, which first removes the
 * shop's products, counts and adjustments. Nothing is sent back to the Sheet: it came from there.
 *
 * The saves the Apps Script already wrote come over as well. A phone that never heard back from
 * the Apps Script sends its save again, to this server by then, and must be told it was done.
 */
export async function importSheet(db: Database, shopId: string, data: SheetExport, replace: boolean): Promise<ImportSummary> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: products.id }).from(products).where(eq(products.shopId, shopId)).limit(1);
    if (existing && !replace) {
      throw new Error('The database already has products. Importing again would double them. To start over from the Sheet, run: npm run import:sheet -- --replace');
    }
    if (existing) {
      const shopStocktakes = tx.select({ id: stocktakes.id }).from(stocktakes).where(eq(stocktakes.shopId, shopId));
      await tx.delete(photoCounts).where(inArray(photoCounts.stocktakeId, shopStocktakes));
      await tx.delete(adjustments).where(inArray(adjustments.stocktakeId, shopStocktakes));
      await tx.delete(products).where(eq(products.shopId, shopId));
      await tx.delete(stocktakes).where(eq(stocktakes.shopId, shopId));
      // Changes still waiting to be copied to the Sheet describe what was just removed. Sent later,
      // they would put into the Sheet what the database no longer has.
      await tx.update(sheetOutbox).set({ failedAt: sql`now()`, lastError: 'Dropped: the database was started over from the Sheet.' })
        .where(and(isNull(sheetOutbox.deliveredAt), isNull(sheetOutbox.failedAt)));
    }

    await saveCurrencies(tx, data.currencies, true);
    await saveLocations(tx, shopId, data.locations);
    // Nothing is counted yet at this point, so places the Sheet no longer lists can go.
    await tx.delete(locations).where(and(eq(locations.shopId, shopId), notInArray(locations.name, data.locations)));
    const locationIds = new Map((await tx.select().from(locations).where(eq(locations.shopId, shopId))).map((place) => [place.name, place.id]));

    const dates = [...new Set([...data.counts.map((row) => row.countDate), ...data.adjustments.map((row) => row.countDate), data.countDate])];
    await tx.insert(stocktakes).values(dates.map((countDate) => ({ shopId, countDate }))).onConflictDoNothing();
    await openStocktake(tx, shopId, data.countDate);
    const stocktakeIds = new Map((await tx.select().from(stocktakes).where(eq(stocktakes.shopId, shopId))).map((stocktake) => [stocktake.countDate, stocktake.id]));

    const skipped: string[] = data.leftOut.map((row) => `${row.tab} row ${row.row}: ${row.why}.`);
    const started = Date.now() - data.products.length;
    const productIds = new Map<string, string>();
    const productNames: { id: string; name: string }[] = [];
    for (const [index, source] of data.products.entries()) {
      const details = parseProductDetails(source, `product ${source.code}`);
      const price = parsePrice({ price: source.price, currency: source.currency }, data.currencies);
      const [created] = await tx.insert(products).values({
        shopId, code: source.code, ...details, packSize: source.packSize, reorderLevel: source.reorderLevel, ...(price ?? {}),
        // A millisecond apart, so the list keeps the order of the Sheet's rows.
        createdAt: new Date(started + index),
      }).returning({ id: products.id });
      const id = (created as { id: string }).id;
      productIds.set(source.code, id);
      productNames.push({ id, name: details.name });
      if (source.imageUrls.length > 0) {
        await tx.insert(productPhotos).values(source.imageUrls.map((url, position) => ({ productId: id, url, position })));
      }
    }

    const counts = data.counts.flatMap((row, index) => {
      const productId = productIds.get(row.code);
      const locationId = locationIds.get(row.location);
      const stocktakeId = stocktakeIds.get(row.countDate);
      if (!productId || !locationId || !stocktakeId) {
        skipped.push(`Count row ${index + 1} (${row.code} at ${row.location}): ${productId ? 'unknown place' : 'no such product'}.`);
        return [];
      }
      // The Sheet keeps the counter inside the note, as "[name] note".
      const [, counter = '', note = row.note] = /^\[([^\]]*)\]\s?(.*)$/s.exec(row.note) ?? [];
      return [{
        stocktakeId, locationId, productId, fullCartons: row.fullCartons, packSize: row.packSize, loosePieces: row.loosePieces,
        confidence: row.confidence, note: note.slice(0, 300), counter: counter || 'Sheet', requestId: 'sheet-import',
      }];
    });
    if (counts.length > 0) await tx.insert(photoCounts).values(counts);

    // Oldest first, so the entry order settles "latest correction" the way the Sheet's timestamps do.
    // An entry with no timestamp is stock added or removed, where the order does not matter.
    const entries = [...data.adjustments].sort((left, right) => left.at.localeCompare(right.at)).flatMap((row, index) => {
      const productId = productNames.find((product) => sameName(product.name, row.productName))?.id;
      const locationId = locationIds.get(row.location);
      const stocktakeId = stocktakeIds.get(row.countDate);
      if (!productId || !locationId || !stocktakeId) {
        skipped.push(`Hand entry ${index + 1} (${row.productName} at ${row.location}): ${productId ? 'unknown place' : 'no such product'}.`);
        return [];
      }
      return [{
        stocktakeId, locationId, productId, kind: row.type, quantity: row.quantity, reason: row.reason.slice(0, 300),
        counter: row.counter || 'Sheet', requestId: 'sheet-import', createdAt: row.at === '' ? new Date(0) : new Date(row.at),
      }];
    });
    if (entries.length > 0) await tx.insert(adjustments).values(entries);

    for (let from = 0; from < data.handledRequests.length; from += 1000) {
      await tx.insert(handledRequests)
        .values(data.handledRequests.slice(from, from + 1000).map((request) => ({ requestId: request.id, action: request.action })))
        .onConflictDoNothing();
    }

    return { products: data.products.length, counts: counts.length, adjustments: entries.length, skipped };
  });
}

