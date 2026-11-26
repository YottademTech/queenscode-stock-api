import { sql } from 'drizzle-orm';
import {
  bigint, boolean, char, check, date, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

// The tables, in the order they depend on each other. `npm run db:generate` turns a change here
// into a migration under drizzle/.
//
// Three rules hold throughout:
// - Counts and adjustments are a ledger. Rows are added, never edited: stock is always worked out
//   from them, so every number can be traced to who entered it and when.
// - Every row belongs to a shop, directly or through its stocktake, location or product, so a
//   second shop later is more rows, not a new design.
// - Money is whole minor units (pesewas) beside a currency code, so sums never drift.

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const detail = (name: string) => text(name).notNull().default('');

export const shops = pgTable('shops', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** IANA name, such as Africa/Accra. Decides what "today" is for the shop. */
  timeZone: text('time_zone').notNull(),
  createdAt: createdAt(),
});

/** ISO 4217 currencies a price can be in. `decimals` is the minor unit: 2 for cedis and pesewas. */
export const currencies = pgTable('currencies', {
  code: char('code', { length: 3 }).primaryKey(),
  name: text('name').notNull(),
  shortName: text('short_name').notNull(),
  decimals: smallint('decimals').notNull(),
}, (table) => [check('currencies_decimals', sql`${table.decimals} between 0 and 3`)]);

/** A place stock is kept: the shop shelf, a warehouse. `position` is the order the app lists them in. */
export const locations = pgTable('locations', {
  id: id(),
  shopId: uuid('shop_id').notNull().references(() => shops.id),
  name: text('name').notNull(),
  position: smallint('position').notNull(),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex('locations_shop_name').on(table.shopId, table.name),
  uniqueIndex('locations_shop_position').on(table.shopId, table.position),
]);

/** One stocktake per count date. Counts and adjustments are filed under the shop's current one. */
export const stocktakes = pgTable('stocktakes', {
  id: id(),
  shopId: uuid('shop_id').notNull().references(() => shops.id),
  countDate: date('count_date', { mode: 'string' }).notNull(),
  isCurrent: boolean('is_current').notNull().default(false),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex('stocktakes_shop_date').on(table.shopId, table.countDate),
  // The database itself refuses a second current stocktake for a shop.
  uniqueIndex('stocktakes_one_current').on(table.shopId).where(sql`${table.isCurrent}`),
]);

export const products = pgTable('products', {
  id: id(),
  shopId: uuid('shop_id').notNull().references(() => shops.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  size: detail('size'),
  barcode: detail('barcode'),
  category: detail('category'),
  expiry: detail('expiry'),
  brand: detail('brand'),
  variant: detail('variant'),
  description: detail('description'),
  batchNumber: detail('batch_number'),
  manufactureDate: detail('manufacture_date'),
  manufacturer: detail('manufacturer'),
  countryOfOrigin: detail('country_of_origin'),
  ingredients: detail('ingredients'),
  directions: detail('directions'),
  otherDetails: detail('other_details'),
  labelText: detail('label_text'),
  qrCode: detail('qr_code'),
  /** Pieces in each bag, sack or carton. */
  packSize: integer('pack_size'),
  /** Pieces at or below which the product shows REORDER. */
  reorderLevel: integer('reorder_level'),
  /** Selling price per piece in the currency's minor unit, set by a person and never read off a photo. */
  priceMinor: bigint('price_minor', { mode: 'number' }),
  currencyCode: char('currency_code', { length: 3 }).references(() => currencies.code),
  /**
   * Goes up by one with every change to the product or its photos. An edit says which version it
   * started from and is refused when the product has moved on, so no change is silently overwritten.
   */
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** A deleted product stays as a row, so the counts once made for it still say what they were for. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  // Among the products not deleted, a code and a name each belong to one product. Two saves that
  // race to add the same product cannot both succeed.
  uniqueIndex('products_shop_code').on(table.shopId, table.code).where(sql`${table.deletedAt} is null`),
  uniqueIndex('products_shop_name').on(table.shopId, sql`lower(${table.name})`).where(sql`${table.deletedAt} is null`),
  index('products_shop_barcode').on(table.shopId, table.barcode),
  check('products_numbers', sql`${table.packSize} >= 0 and ${table.reorderLevel} >= 0 and ${table.priceMinor} >= 0`),
  check('products_price_has_currency', sql`(${table.priceMinor} is null) = (${table.currencyCode} is null)`),
]);

/** A product's photos, in the order shown. `url` is where the photo is stored (Google Drive for now). */
export const productPhotos = pgTable('product_photos', {
  id: id(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  position: smallint('position').notNull(),
  createdAt: createdAt(),
}, (table) => [uniqueIndex('product_photos_order').on(table.productId, table.position)]);

/** Ledger: one row per product counted from a photo. `pack_size` empty means the product's own. */
export const photoCounts = pgTable('photo_counts', {
  id: id(),
  stocktakeId: uuid('stocktake_id').notNull().references(() => stocktakes.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  productId: uuid('product_id').notNull().references(() => products.id),
  fullCartons: integer('full_cartons').notNull(),
  packSize: integer('pack_size'),
  loosePieces: integer('loose_pieces').notNull(),
  confidence: text('confidence').notNull(),
  note: text('note').notNull().default(''),
  counter: text('counter').notNull(),
  /** The save this row arrived in. */
  requestId: text('request_id').notNull(),
  createdAt: createdAt(),
}, (table) => [
  index('photo_counts_lookup').on(table.stocktakeId, table.productId, table.locationId),
  check('photo_counts_numbers', sql`${table.fullCartons} >= 0 and ${table.loosePieces} >= 0 and ${table.packSize} >= 0`),
  check('photo_counts_confidence', sql`${table.confidence} in ('High', 'Medium', 'Low')`),
]);

/**
 * Ledger: one row per entry made by hand. `correct` replaces the photo count for that product and
 * place (the latest one wins); `add` and `remove` are applied on top.
 */
export const adjustments = pgTable('adjustments', {
  id: id(),
  /** Entry order, which settles "latest" between two corrections made in the same instant. */
  seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
  stocktakeId: uuid('stocktake_id').notNull().references(() => stocktakes.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  productId: uuid('product_id').notNull().references(() => products.id),
  kind: text('kind').notNull(),
  quantity: integer('quantity').notNull(),
  reason: text('reason').notNull().default(''),
  counter: text('counter').notNull(),
  requestId: text('request_id').notNull(),
  createdAt: createdAt(),
}, (table) => [
  index('adjustments_lookup').on(table.stocktakeId, table.productId, table.locationId),
  check('adjustments_quantity', sql`${table.quantity} >= 0`),
  check('adjustments_kind', sql`${table.kind} in ('correct', 'add', 'remove')`),
]);

/**
 * Every save that was written, by the ID the phone gave it. A phone sends a save again when the
 * signal drops; the second arrival finds its ID here and writes nothing.
 */
export const handledRequests = pgTable('handled_requests', {
  requestId: text('request_id').primaryKey(),
  action: text('action').notNull(),
  handledAt: timestamp('handled_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Changes waiting to be copied to the Google Sheet. A row is added in the same transaction as the
 * change it describes, so the Sheet is told of exactly what was saved, in the order it was saved.
 */
export const sheetOutbox = pgTable('sheet_outbox', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  /** Sent as the Sheet's request ID, so an event delivered twice is written once. */
  eventId: uuid('event_id').notNull().defaultRandom(),
  payload: jsonb('payload').notNull(),
  createdAt: createdAt(),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  /** Set when the Sheet refused the event for good (it is full, say). Later events still go. */
  failedAt: timestamp('failed_at', { withTimezone: true }),
  lastError: text('last_error'),
}, (table) => [index('sheet_outbox_waiting').on(table.id).where(sql`${table.deliveredAt} is null and ${table.failedAt} is null`)]);

/** How many photos were sent to Claude each day (UTC), for the daily limit. */
export const claudeUsage = pgTable('claude_usage', {
  day: date('day', { mode: 'string' }).primaryKey(),
  calls: integer('calls').notNull(),
});
