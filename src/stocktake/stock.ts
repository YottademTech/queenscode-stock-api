import { sql } from 'drizzle-orm';
import type { Queryable } from '../db/client.ts';
import type { ShopContext } from '../shop/context.ts';

export type StockRow = {
  code: string;
  name: string;
  locations: { location: string; photoCount: number; correction: number | null; addRemove: number; final: number }[];
  total: number;
  photoTotal: number;
  difference: number;
  reorderLevel: number | null;
  /** REORDER when the total is at or below the reorder level. */
  status: string;
  /** CHECK when a photo count was Low confidence and no one has corrected it by hand. */
  review: string;
};

type Cell = {
  code: string; name: string; reorder_level: number | null; location: string;
  photo_count: number; correction: number | null; add_remove: number; any_low: boolean;
};

/**
 * The stock of the open stocktake, worked out from the ledger in one query. For each product and
 * place: the pieces counted by photo, the latest correction made by hand (which replaces the photo
 * count), and stock added or removed by hand on top.
 */
export async function readStock(db: Queryable, shop: ShopContext): Promise<{ rows: StockRow[] }> {
  const stocktake = shop.stocktake.id;
  const cells = await db.execute(sql`
    with listed as (
      select id, code, name, pack_size, reorder_level, created_at
      from products where shop_id = ${shop.id} and deleted_at is null
    ),
    counted as (
      select c.product_id, c.location_id,
             sum(c.full_cartons * coalesce(c.pack_size, p.pack_size, 0) + c.loose_pieces)::int as pieces,
             bool_or(c.confidence = 'Low') as any_low
      from photo_counts c join listed p on p.id = c.product_id
      where c.stocktake_id = ${stocktake}
      group by c.product_id, c.location_id
    ),
    corrected as (
      select distinct on (product_id, location_id) product_id, location_id, quantity
      from adjustments
      where stocktake_id = ${stocktake} and kind = 'correct'
      order by product_id, location_id, created_at desc, seq desc
    ),
    moved as (
      select product_id, location_id,
             sum(case kind when 'add' then quantity else -quantity end)::int as delta
      from adjustments
      where stocktake_id = ${stocktake} and kind in ('add', 'remove')
      group by product_id, location_id
    )
    select p.code, p.name, p.reorder_level, l.name as location,
           coalesce(counted.pieces, 0) as photo_count,
           corrected.quantity as correction,
           coalesce(moved.delta, 0) as add_remove,
           coalesce(counted.any_low, false) as any_low
    from listed p
    join locations l on l.shop_id = ${shop.id}
    left join counted on counted.product_id = p.id and counted.location_id = l.id
    left join corrected on corrected.product_id = p.id and corrected.location_id = l.id
    left join moved on moved.product_id = p.id and moved.location_id = l.id
    order by p.created_at, p.code, l.position
  `) as unknown as Cell[];

  const rows: StockRow[] = [];
  let anyLow = false;
  let anyCorrection = false;
  for (const cell of cells) {
    let row = rows.at(-1);
    if (!row || row.code !== cell.code) {
      row = { code: cell.code, name: cell.name, locations: [], total: 0, photoTotal: 0, difference: 0, reorderLevel: cell.reorder_level, status: '', review: '' };
      rows.push(row);
      anyLow = false;
      anyCorrection = false;
    }
    const final = (cell.correction ?? cell.photo_count) + cell.add_remove;
    row.locations.push({ location: cell.location, photoCount: cell.photo_count, correction: cell.correction, addRemove: cell.add_remove, final });
    row.total += final;
    row.photoTotal += cell.photo_count;
    row.difference = row.total - row.photoTotal;
    anyLow ||= cell.any_low;
    anyCorrection ||= cell.correction !== null;
    row.status = row.reorderLevel === null ? 'Set reorder level' : row.total <= row.reorderLevel ? 'REORDER' : 'OK';
    row.review = anyLow && !anyCorrection ? 'CHECK' : '';
  }
  return { rows };
}
