import { and, eq, sql } from 'drizzle-orm';
import { DEFAULT_CURRENCIES, type Currency } from '../catalog/prices.ts';
import type { Database, Transaction } from '../db/client.ts';
import { currencies, locations, shops, stocktakes } from '../db/schema.ts';
import { isoDay } from '../lib/text.ts';
import type { SheetMirror } from '../sheet/events.ts';

export const DEFAULT_LOCATIONS = ['Shop shelf', 'Warehouse bags', 'Warehouse sacks'];

export type ShopSettings = { slug: string; name: string; timeZone: string };

/**
 * Makes sure the shop exists with currencies, places to count in and an open stocktake. Safe to
 * repeat: what is already there is left as it is. A new shop starts a stocktake dated today.
 */
export async function ensureShop(db: Database, settings: ShopSettings): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.insert(shops).values(settings).onConflictDoNothing({ target: shops.slug });
    const [shop] = await tx.select({ id: shops.id }).from(shops).where(eq(shops.slug, settings.slug));
    const shopId = (shop as { id: string }).id;

    await saveCurrencies(tx, DEFAULT_CURRENCIES, false);
    const [place] = await tx.select({ id: locations.id }).from(locations).where(eq(locations.shopId, shopId)).limit(1);
    if (!place) await saveLocations(tx, shopId, DEFAULT_LOCATIONS);
    const [open] = await tx.select({ id: stocktakes.id }).from(stocktakes)
      .where(and(eq(stocktakes.shopId, shopId), eq(stocktakes.isCurrent, true))).limit(1);
    if (!open) await openStocktake(tx, shopId, isoDay(new Date(), settings.timeZone));
    return shopId;
  });
}

export async function saveCurrencies(tx: Transaction, list: readonly Currency[], replace: boolean): Promise<void> {
  if (list.length === 0) return;
  const insert = tx.insert(currencies).values([...list]);
  await (replace
    ? insert.onConflictDoUpdate({ target: currencies.code, set: { name: sql`excluded.name`, shortName: sql`excluded.short_name`, decimals: sql`excluded.decimals` } })
    : insert.onConflictDoNothing());
}

/** Sets the shop's places, in order. A place that already exists keeps its counts and takes its new position. */
export async function saveLocations(tx: Transaction, shopId: string, names: readonly string[]): Promise<void> {
  // Positions are unique per shop, so the old ones are moved out of the way before the new order is written.
  await tx.update(locations).set({ position: sql`${locations.position} + 1000` }).where(eq(locations.shopId, shopId));
  for (const [index, name] of names.entries()) {
    await tx.insert(locations).values({ shopId, name, position: index + 1 })
      .onConflictDoUpdate({ target: [locations.shopId, locations.name], set: { position: index + 1 } });
  }
}

/**
 * Makes the stocktake of `countDate` the one counts are filed under, creating it if it is new.
 * Going back to an earlier date opens that stocktake again with everything counted in it.
 */
export async function openStocktake(tx: Transaction, shopId: string, countDate: string, mirror?: SheetMirror): Promise<void> {
  await tx.update(stocktakes).set({ isCurrent: false }).where(and(eq(stocktakes.shopId, shopId), eq(stocktakes.isCurrent, true)));
  await tx.insert(stocktakes).values({ shopId, countDate, isCurrent: true })
    .onConflictDoUpdate({ target: [stocktakes.shopId, stocktakes.countDate], set: { isCurrent: true } });
  // The Sheet's Stock tab only shows the rows of its own count date, so it follows.
  await mirror?.enqueue(tx, { kind: 'settings', countDate });
}
