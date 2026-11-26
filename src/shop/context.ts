import { and, asc, eq } from 'drizzle-orm';
import type { Queryable } from '../db/client.ts';
import { locations, shops, stocktakes } from '../db/schema.ts';
import { AppError } from '../errors.ts';

export type Location = { id: string; name: string; position: number };

/** The shop a request is for, with the stocktake its counts are filed under and its places. */
export type ShopContext = {
  id: string;
  name: string;
  timeZone: string;
  stocktake: { id: string; countDate: string };
  locations: readonly Location[];
};

/**
 * Read for every request, so a stocktake started or a place added while the server runs takes
 * effect at once. Three small indexed lookups.
 */
export async function loadShop(db: Queryable, slug: string): Promise<ShopContext> {
  const [shop] = await db.select().from(shops).where(eq(shops.slug, slug)).limit(1);
  if (!shop) throw new AppError('not_configured', 'The shop is not set up on the server. Run "npm run db:setup".');

  const [stocktake] = await db.select({ id: stocktakes.id, countDate: stocktakes.countDate }).from(stocktakes)
    .where(and(eq(stocktakes.shopId, shop.id), eq(stocktakes.isCurrent, true))).limit(1);
  if (!stocktake) throw new AppError('not_configured', 'No stocktake is open. Run "npm run stocktake -- YYYY-MM-DD" on the server.');

  const places = await db.select({ id: locations.id, name: locations.name, position: locations.position }).from(locations)
    .where(eq(locations.shopId, shop.id)).orderBy(asc(locations.position));
  if (places.length === 0) throw new AppError('not_configured', 'The shop has no places to count in. Run "npm run db:setup".');

  return { id: shop.id, name: shop.name, timeZone: shop.timeZone, stocktake, locations: places };
}

export function locationNamed(shop: ShopContext, name: string): Location {
  const location = shop.locations.find((candidate) => candidate.name === name);
  // Callers validate the name against shop.locations first, so this is a programming error.
  if (!location) throw new Error(`Unknown location "${name}".`);
  return location;
}
