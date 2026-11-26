// npm run import:sheet            (first time)
// npm run import:sheet -- --replace   (start over from the Sheet, discarding what the database holds)
// Reads the whole Google Sheet through the Apps Script and fills the database from it.
import { loadConfigOrExit } from '../config.ts';
import { openDatabase, runMigrations } from '../db/client.ts';
import { sheetGateway } from '../sheet/gateway.ts';
import { importSheet, sheetExportSchema } from '../sheet/import.ts';
import { ensureShop } from '../shop/setup.ts';

const config = loadConfigOrExit();
if (config.SHEET_GATEWAY_URL === '') {
  console.error('Set SHEET_GATEWAY_URL and SHEET_GATEWAY_SECRET to the Apps Script first.');
  process.exit(1);
}

const reply = await sheetGateway(config.SHEET_GATEWAY_URL, config.SHEET_GATEWAY_SECRET).call('exportAll', {}, 120_000);
if (!reply.ok) {
  console.error(reply.error.message === 'Unknown action.'
    ? 'The deployed Apps Script is an older version. Paste the current Code.gs and deploy a new version, then run this again.'
    : `The Apps Script refused: ${reply.error.code}: ${reply.error.message}`);
  process.exit(1);
}
const data = sheetExportSchema.parse(reply.data);

const { db, close } = openDatabase(config.DATABASE_URL_UNPOOLED || config.DATABASE_URL, 2);
try {
  await runMigrations(db);
  const shopId = await ensureShop(db, { slug: config.SHOP_SLUG, name: config.SHOP_NAME, timeZone: config.SHOP_TIME_ZONE });
  const summary = await importSheet(db, shopId, data, process.argv.includes('--replace'));
  console.log(`Imported ${summary.products} products, ${summary.counts} photo counts and ${summary.adjustments} hand entries. Counts are filed under ${data.countDate}.`);
  if (summary.skipped.length > 0) console.log(`Left out, because the Sheet row points at nothing:\n  ${summary.skipped.join('\n  ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await close();
}
