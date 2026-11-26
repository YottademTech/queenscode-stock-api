import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Queryable, Transaction } from '../db/client.ts';
import { currencies, productPhotos, products } from '../db/schema.ts';
import { lockCatalog, wasHandled, writeOnce, type SaveResult } from '../db/writes.ts';
import type { Deps } from '../deps.ts';
import { AppError } from '../errors.ts';
import { requestIdOf, requiredText } from '../lib/validate.ts';
import { parseImage, type EncodedImage } from '../photos/store.ts';
import type { ShopContext } from '../shop/context.ts';
import { parseProductInput, pickDetails, type ProductDetails, type ProductInput } from './details.ts';
import { makeProductCode } from './names.ts';
import { listCurrencies, majorUnits, parsePrice, type StoredPrice } from './prices.ts';

/** Photos kept for one product (front, side, top, base...). */
export const MAX_PHOTOS_PER_PRODUCT = 10;
/** New product photos in one save, which keeps the request a reasonable size. */
const MAX_NEW_PHOTOS_PER_SAVE = 6;

export type ProductRow = typeof products.$inferSelect;

/** A product as the app receives it. */
export type PublicProduct = ProductDetails & {
  code: string;
  packSize: number | null;
  reorderLevel: number | null;
  /** Every photo, in order; `imageUrl` is the first, the one the product list shows. */
  imageUrls: string[];
  imageUrl: string;
  /** Selling price per piece in the currency's major unit (cedis), or null. */
  price: number | null;
  currency: string;
  /** Sent back with an edit, so the save can tell that the product changed in between. */
  version: string;
};

const notDeleted = (shopId: string) => and(eq(products.shopId, shopId), isNull(products.deletedAt));

export async function listProducts(db: Queryable, shopId: string, onlyIds?: readonly string[]): Promise<PublicProduct[]> {
  if (onlyIds && onlyIds.length === 0) return [];
  const rows = await db.select({ product: products, decimals: currencies.decimals }).from(products)
    .leftJoin(currencies, eq(currencies.code, products.currencyCode))
    .where(onlyIds ? and(notDeleted(shopId), inArray(products.id, [...onlyIds])) : notDeleted(shopId))
    // The order products were added in, as the Sheet lists them.
    .orderBy(asc(products.createdAt), asc(products.code));
  if (rows.length === 0) return [];

  const photos = await db.select({ productId: productPhotos.productId, url: productPhotos.url }).from(productPhotos)
    .where(inArray(productPhotos.productId, rows.map((row) => row.product.id)))
    .orderBy(asc(productPhotos.productId), asc(productPhotos.position));
  const urlsByProduct = Map.groupBy(photos, (photo) => photo.productId);

  return rows.map(({ product, decimals }) => {
    const imageUrls = (urlsByProduct.get(product.id) ?? []).map((photo) => photo.url);
    const hasPrice = product.priceMinor !== null && product.currencyCode !== null && decimals !== null;
    return {
      ...pickDetails(product),
      code: product.code,
      packSize: product.packSize,
      reorderLevel: product.reorderLevel,
      imageUrls,
      imageUrl: imageUrls[0] ?? '',
      price: hasPrice ? majorUnits(product.priceMinor as number, decimals) : null,
      currency: hasPrice ? (product.currencyCode as string) : '',
      version: String(product.version),
    };
  });
}

/** Tells the Sheet what a product looks like now. Called inside the transaction that changed it. */
export async function mirrorProducts(deps: Deps, tx: Transaction, shopId: string, productIds: readonly string[]): Promise<void> {
  for (const product of await listProducts(tx, shopId, productIds)) {
    await deps.mirror.enqueue(tx, { kind: 'product', product });
  }
}

async function findProduct(db: Queryable, shopId: string, code: string, lock: boolean): Promise<ProductRow | null> {
  const query = db.select().from(products).where(and(notDeleted(shopId), eq(products.code, code))).limit(1);
  // The lock holds until the transaction ends: no one else can change this product meanwhile.
  const [row] = lock ? await query.for('update') : await query;
  return row ?? null;
}

const GONE = 'That product is no longer in the list. Reload the app.';

/** What changes in a product's photos, and the version the edit started from. */
type ProductChange = { remove: string[] | null; keep: string[] | null; added: number; version: string | null };

/**
 * Adds or edits a product. Photos: `images` are new ones, added after the photos the product keeps.
 * `removeImageUrls` names the photos the person removed. An older app sends `keepImageUrls`, the
 * photos to keep in their order, or one `image`. With neither list every existing photo stays.
 *
 * Several people can have the same product open. `productVersion` is the version the form was
 * opened with: when the product has changed since, the save is refused, so one person's changes
 * are never written over by another's older copy.
 *
 * Storing photos is slow, so it happens before the transaction and removing them after it: a save
 * with photos holds no lock while it talks to Google.
 */
export async function saveProduct(deps: Deps, shop: ShopContext, request: Record<string, unknown>): Promise<SaveResult> {
  const input = parseProductInput(request.product);
  const images = parseProductImages(request);
  const change: ProductChange = {
    remove: request.removeImageUrls === undefined || request.removeImageUrls === null ? null : parseUrlList(request.removeImageUrls),
    keep: request.keepImageUrls === undefined || request.keepImageUrls === null ? null : parseUrlList(request.keepImageUrls),
    added: images.length,
    version: request.productVersion === undefined || request.productVersion === null ? null : String(request.productVersion),
  };

  const newUrls: string[] = [];
  let removedUrls: string[] = [];
  let written = false;
  try {
    if (images.length > 0) {
      // A save that was already handled, or that would be refused, stores no photos.
      if (await wasHandled(deps.db, requestIdOf(request))) return { duplicate: true };
      const early = await planProductSave(deps.db, shop, request, input, change, false);
      newUrls.push(...await deps.photos.store(early.code, images));
    }

    const result = await writeOnce(deps.db, request, async (tx) => {
      if (!input.code) await lockCatalog(tx, shop.id);
      // Decided again from the database as it is now, with the product locked.
      const plan = await planProductSave(tx, shop, request, input, change, true);
      const { name: _name, ...detailsButName } = pickDetails(input);

      let productId: string;
      if (plan.existing) {
        productId = plan.existing.id;
        await tx.update(products).set({
          // The name stays: it is how staff and the Sheet know the product.
          ...detailsButName,
          packSize: input.packSize,
          reorderLevel: input.reorderLevel,
          // The price is only written when one was sent: an older app leaves it alone.
          ...(plan.price ?? {}),
          version: sql`${products.version} + 1`,
          updatedAt: sql`now()`,
        }).where(eq(products.id, productId));
      } else {
        const [created] = await tx.insert(products).values({
          shopId: shop.id, code: plan.code, ...pickDetails(input),
          packSize: input.packSize, reorderLevel: input.reorderLevel, ...(plan.price ?? {}),
        }).returning({ id: products.id });
        productId = (created as { id: string }).id;
      }

      if (newUrls.length > 0 || plan.removedUrls.length > 0) {
        await tx.delete(productPhotos).where(eq(productPhotos.productId, productId));
        const urls = plan.keptUrls.concat(newUrls);
        if (urls.length > 0) await tx.insert(productPhotos).values(urls.map((url, position) => ({ productId, url, position })));
      }
      removedUrls = plan.removedUrls;
      await mirrorProducts(deps, tx, shop.id, [productId]);
    });
    written = !result.duplicate;
    return result;
  } finally {
    // Photos no product refers to: the removed ones after a save, the new ones after a save that failed.
    const orphaned = written ? removedUrls : newUrls;
    if (orphaned.length > 0) {
      void deps.photos.trash(orphaned).catch((error: unknown) => deps.log.error('Could not remove unused product photos.', error));
    }
  }
}

/** Everything that can refuse a product save, decided from the database at this moment. Nothing is written. */
async function planProductSave(
  db: Queryable, shop: ShopContext, request: Record<string, unknown>, input: ProductInput, change: ProductChange, lock: boolean,
) {
  let existing: ProductRow | null = null;
  if (input.code) {
    existing = await findProduct(db, shop.id, input.code, lock);
    if (!existing) throw new AppError('invalid_request', GONE);
    if (change.version !== null && change.version !== String(existing.version)) {
      throw new AppError('conflict', 'This product was changed after you opened it, so your changes were not saved. Go back, open the product again to see the change, then make yours.');
    }
  } else {
    const [sameName] = await db.select({ id: products.id }).from(products)
      .where(and(notDeleted(shop.id), sql`lower(${products.name}) = lower(${input.name})`)).limit(1);
    if (sameName) {
      throw new AppError('invalid_request', 'A product with this name already exists. Add the size or variant to the name to tell them apart.');
    }
  }

  // Only links the product already has can be kept, so nothing else can be stored as its photo.
  const existingUrls = existing ? await photoUrls(db, existing.id) : [];
  const keptUrls = change.remove !== null ? existingUrls.filter((url) => !change.remove?.includes(url))
    : change.keep !== null ? change.keep.filter((url) => existingUrls.includes(url))
      : existingUrls;
  if (keptUrls.length + change.added > MAX_PHOTOS_PER_PRODUCT) {
    throw new AppError('invalid_request', `A product can have up to ${MAX_PHOTOS_PER_PRODUCT} photos. Remove some before adding more.`);
  }

  return {
    existing,
    // A new product's code names its photo files too. Chosen before the lock, it can differ from
    // the code the product ends up with when another product took it meanwhile; only the file name shows it.
    code: existing ? existing.code : makeProductCode(input.name, input.size, await takenCodes(db, shop.id)),
    keptUrls,
    removedUrls: existingUrls.filter((url) => !keptUrls.includes(url)),
    price: parsePrice(request.product, await listCurrencies(db)),
  };
}

async function photoUrls(db: Queryable, productId: string): Promise<string[]> {
  const rows = await db.select({ url: productPhotos.url }).from(productPhotos)
    .where(eq(productPhotos.productId, productId)).orderBy(asc(productPhotos.position));
  return rows.map((row) => row.url);
}

export async function takenCodes(db: Queryable, shopId: string): Promise<string[]> {
  return (await db.select({ code: products.code }).from(products).where(notDeleted(shopId))).map((row) => row.code);
}

/** Sets or clears a product's selling price, on its own: no stock is adjusted. */
export async function setProductPrice(deps: Deps, shop: ShopContext, request: Record<string, unknown>): Promise<SaveResult> {
  const code = requiredText(request.productCode, 'product', 60);
  const price = parsePrice(request, await listCurrencies(deps.db));
  if (price === undefined) throw new AppError('invalid_request', 'Enter the price, or leave it empty to clear it.');

  return writeOnce(deps.db, request, async (tx) => {
    const product = await findProduct(tx, shop.id, code, true);
    if (!product) throw new AppError('invalid_request', GONE);
    await writePrice(tx, product.id, price);
    await mirrorProducts(deps, tx, shop.id, [product.id]);
  });
}

async function writePrice(tx: Transaction, productId: string, price: StoredPrice): Promise<void> {
  await tx.update(products).set({ ...price, version: sql`${products.version} + 1`, updatedAt: sql`now()` }).where(eq(products.id, productId));
}

/**
 * Removes a product from the list, with everything counted for it: a product added later under the
 * same code or name starts from nothing. The row and its counts are kept, marked deleted, so the
 * history still says what was counted. Its photos stay where they are stored.
 */
export async function deleteProduct(deps: Deps, shop: ShopContext, request: Record<string, unknown>): Promise<SaveResult> {
  const code = requiredText(request.productCode, 'product', 60);

  return writeOnce(deps.db, request, async (tx) => {
    const product = await findProduct(tx, shop.id, code, true);
    if (!product) throw new AppError('invalid_request', GONE);
    await tx.update(products).set({ deletedAt: sql`now()`, version: sql`${products.version} + 1`, updatedAt: sql`now()` })
      .where(eq(products.id, product.id));
    await deps.mirror.enqueue(tx, { kind: 'productDeleted', code: product.code, name: product.name });
  });
}

function parseProductImages(request: Record<string, unknown>): EncodedImage[] {
  if (request.images === undefined || request.images === null) {
    return request.image === undefined || request.image === null ? [] : [parseImage(request.image)];
  }
  if (!Array.isArray(request.images) || request.images.length > MAX_NEW_PHOTOS_PER_SAVE) {
    throw new AppError('invalid_request', `Add at most ${MAX_NEW_PHOTOS_PER_SAVE} photos at a time.`);
  }
  return request.images.map(parseImage);
}

function parseUrlList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_PHOTOS_PER_PRODUCT) throw new AppError('invalid_request', 'The list of photos is not valid.');
  return value.map((url) => String(url));
}

