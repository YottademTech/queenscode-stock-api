// npm run stocktake -- 2026-12-01
// Starts (or reopens) the stocktake of that date. Counts and adjustments are filed under it from
// then on, and the Sheet's count date follows.
import { eq } from 'drizzle-orm';
import { loadConfigOrExit } from '../config.ts';
import { openDatabase } from '../db/client.ts';
import { shops } from '../db/schema.ts';
import { enqueueSheetEvent, noMirror } from '../sheet/events.ts';
import { openStocktake } from '../shop/setup.ts';

const countDate = process.argv[2] ?? '';
if (!/^\d{4}-\d{2}-\d{2}$/.test(countDate) || Number.isNaN(Date.parse(countDate))) {
  console.error('Give the count date as YYYY-MM-DD, for example: npm run stocktake -- 2026-12-01');
  process.exit(1);
}

const config = loadConfigOrExit();
const { db, close } = openDatabase(config.DATABASE_URL_UNPOOLED || config.DATABASE_URL, 2);
try {
  const [shop] = await db.select({ id: shops.id }).from(shops).where(eq(shops.slug, config.SHOP_SLUG));
  if (!shop) throw new Error('The shop is not set up. Run "npm run db:setup" first.');
  // Queued for the running server to send; this script does not talk to Google itself.
  const mirror = config.SHEET_GATEWAY_URL === '' ? noMirror : { ...noMirror, enqueue: enqueueSheetEvent };
  await db.transaction((tx) => openStocktake(tx, shop.id, countDate, mirror));
  console.log(`Counts are now filed under ${countDate}.`);
} finally {
  await close();
}
