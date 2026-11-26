import { and, eq, isNull } from 'drizzle-orm';
import { adjustments, products } from '../db/schema.ts';
import { writeOnce, type SaveResult } from '../db/writes.ts';
import type { Deps } from '../deps.ts';
import { AppError } from '../errors.ts';
import { oneOf, optionalText, requestIdOf, requiredText, wholeNumber } from '../lib/validate.ts';
import { locationNamed, type ShopContext } from '../shop/context.ts';

export const ADJUSTMENT_KINDS = ['correct', 'add', 'remove'] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

/** What the app calls each kind of entry made by hand. */
export const ADJUSTMENT_LABELS: Record<AdjustmentKind, string> = {
  correct: 'Correct the count',
  add: 'Add stock',
  remove: 'Remove stock',
};

/**
 * Records an entry made by hand. `correct` replaces the photo count for that product and place;
 * `add` and `remove` are applied on top. The entry is a new ledger row: nothing earlier is changed.
 */
export async function saveAdjustment(deps: Deps, shop: ShopContext, request: Record<string, unknown>): Promise<SaveResult> {
  const location = locationNamed(shop, oneOf(request.location, 'location', shop.locations.map((place) => place.name)));
  const counter = requiredText(request.counter, 'counter name', 40);
  const kind = oneOf(request.type, 'adjustment type', ADJUSTMENT_KINDS);
  const quantity = wholeNumber(request.quantity, 'quantity');
  const reason = optionalText(request.reason, 'reason', 300);
  const code = requiredText(request.productCode, 'product', 60);
  const requestId = requestIdOf(request);

  return writeOnce(deps.db, request, async (tx) => {
    const [product] = await tx.select({ id: products.id, name: products.name }).from(products)
      .where(and(eq(products.shopId, shop.id), isNull(products.deletedAt), eq(products.code, code))).limit(1);
    if (!product) throw new AppError('invalid_request', 'That product is no longer in the list. Reload the app.');

    const [entry] = await tx.insert(adjustments).values({
      stocktakeId: shop.stocktake.id, locationId: location.id, productId: product.id, kind, quantity, reason, counter, requestId,
    }).returning({ createdAt: adjustments.createdAt });

    await deps.mirror.enqueue(tx, {
      kind: 'adjustment', at: (entry as { createdAt: Date }).createdAt.toISOString(), counter,
      countDate: shop.stocktake.countDate, location: location.name, productName: product.name, type: kind, quantity, reason,
    });
  });
}
