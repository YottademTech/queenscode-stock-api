// npm run db:setup
// Creates the tables and the shop. Run once on a new database; safe to run again.
// On Vercel it runs as the build step of every production deployment ("npm run vercel-build").
import { loadConfigOrExit } from '../config.ts';
import { openDatabase, runMigrations } from '../db/client.ts';
import { ensureShop } from '../shop/setup.ts';

// A preview build of a branch must not change the tables the live server is using.
if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
  console.log(`Skipping the database set-up: this is a ${process.env.VERCEL_ENV} build, and only production builds change the tables.`);
  process.exit(0);
}

const config = loadConfigOrExit();
const { db, close } = openDatabase(config.DATABASE_URL_UNPOOLED || config.DATABASE_URL, 2);
try {
  await runMigrations(db);
  await ensureShop(db, { slug: config.SHOP_SLUG, name: config.SHOP_NAME, timeZone: config.SHOP_TIME_ZONE });
  console.log(`The database is ready for "${config.SHOP_NAME}".`);
} finally {
  await close();
}
