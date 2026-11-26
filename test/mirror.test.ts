import { eq, sql } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import { sheetOutbox } from '../src/db/schema.ts';
import { PHOTO, adjustment, countRow, driveLink, noDetails, productSave, requestId, saveCounts, testServer, type TestServer } from './harness.ts';

// The Google Sheet is kept up to date in the background. The Sheet here is the real Apps Script
// code on its in-memory stand-ins, so these tests check what would actually land in the Sheet.

const sheetProducts = (server: TestServer) => server.sheet.post({ action: 'bootstrap' }).data.products as Record<string, unknown>[];
const sheetCounts = (server: TestServer) => {
  const tab = server.sheet.workbook.get('Claude_Counts');
  return [2, 3, 4, 5, 6, 7, 8].map((row) => tab?.rowValues(row, 10) ?? []).filter((cells) => cells[2] !== '').map((cells) => [cells[1], cells[2], cells[4], cells[5], cells[6], cells[8], cells[9]]);
};
const withoutVersion = (products: Record<string, unknown>[]) => products.map(({ version: _version, ...product }) => product);
const makeDue = (server: TestServer) => server.db.execute(sql`update sheet_outbox set next_attempt_at = now() where delivered_at is null`);

test('a save returns without waiting for Google, and the Sheet then shows exactly what the database holds', async () => {
  const server = await testServer();
  await server.post('saveCounts', saveCounts([
    countRow({ productCode: null, newProduct: { ...noDetails, name: 'QBH Carrot Oil', size: '100ml', barcode: '0603400012347' }, fullCartons: 1, packSize: 24, loosePieces: 2 }),
    countRow({ productCode: 'RG-YEL', loosePieces: 3, confidence: 'Low', note: 'Back row hidden.', details: { ...noDetails, brand: 'Rich Glow' } }),
  ], { location: 'Warehouse bags', counter: 'Atsu' }));
  await server.post('saveProduct', productSave({ price: 25.5, currency: 'GHS' }, { images: [PHOTO, PHOTO] }));
  await server.post('setPrice', { requestId: requestId(), productCode: 'RG-BLK-500', price: 40, currency: 'GHS' });
  await server.post('adjust', adjustment({ type: 'remove', quantity: 2, reason: 'Damaged' }));

  // Saved in the database, queued for the Sheet, and the Sheet not yet touched.
  expect((await server.queued()).map((event) => event.payload.kind)).toEqual(['product', 'product', 'counts', 'product', 'product', 'adjustment']);
  expect(server.state.sheetCalls.filter((action) => action === 'mirror')).toHaveLength(0);
  expect(sheetProducts(server)).toHaveLength(2);

  await server.drainSheet();
  expect((await server.queued()).every((event) => event.deliveredAt !== null)).toBe(true);
  expect(server.errors).toEqual([]);

  // Product for product, field for field, the Sheet reads the same as the database.
  const database = (await server.post('bootstrap')).data.products;
  expect(withoutVersion(sheetProducts(server))).toEqual(withoutVersion(database));
  expect(database.find((product: { code: string }) => product.code === 'QBHGO-250')).toMatchObject({ price: 25.5, imageUrls: [driveLink(1), driveLink(2)] });
  expect(sheetCounts(server)).toEqual([
    ['Shop shelf', 'RG-YEL', 0, '', 8, 'Medium', 'Photo 18:49.'],
    ['Warehouse bags', 'QBHCO-100', 1, 24, 2, 'High', '[Atsu] Clear single row.'],
    ['Warehouse bags', 'RG-YEL', 0, '', 3, 'Low', '[Atsu] Back row hidden.'],
  ]);
  const entry = server.sheet.workbook.get('Form_Adjustments')?.rowValues(2, 8) ?? [];
  expect([entry[1], ...entry.slice(3)]).toEqual(['Ama', 'Shop shelf', 'Rich Glow Yellow Tone Lotion', 'Remove stock', 2, 'Damaged']);
  expect((entry[2] as Date).toISOString()).toBe('2026-11-23T00:00:00.000Z');
  expect(Date.now() - (entry[0] as Date).getTime()).toBeLessThan(60_000);

  // A delete follows too.
  await server.post('deleteProduct', { requestId: requestId(), productCode: 'RG-YEL' });
  await server.drainSheet();
  expect(withoutVersion(sheetProducts(server))).toEqual(withoutVersion((await server.post('bootstrap')).data.products));
  expect(sheetCounts(server).map((cells) => cells[1])).toEqual(['QBHCO-100']);
});

test('while Google cannot be reached saves still succeed; the changes wait, and go in order once it is back', async () => {
  const server = await testServer();
  await server.drainSheet();
  server.state.sheetDown = true;

  expect((await server.post('saveCounts', saveCounts([countRow({ productCode: null, newProduct: { ...noDetails, name: 'QBH Carrot Oil', size: '100ml' }, loosePieces: 4 })]))).ok).toBe(true);
  expect((await server.post('adjust', adjustment({ productCode: 'RG-BLK-500', quantity: 9 }))).ok).toBe(true);
  await server.drainSheet();
  expect((await server.stockOf('QBHCO-100')).total).toBe(4);

  // Tried again at once, nothing is sent: the first change is not due, and the rest wait behind it.
  const [first] = await server.queued();
  expect(first).toMatchObject({ attempts: 1, deliveredAt: null, failedAt: null });
  expect(first?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  server.state.sheetDown = false;
  const callsBefore = server.state.sheetCalls.length;
  await server.drainSheet();
  expect(server.state.sheetCalls.slice(callsBefore).filter((action) => action === 'mirror')).toHaveLength(0);

  await makeDue(server);
  await server.drainSheet();
  expect((await server.queued()).map((event) => [event.payload.kind, event.deliveredAt !== null])).toEqual([['product', true], ['counts', true], ['adjustment', true]]);
  expect(sheetProducts(server).map((product) => product.code)).toEqual(['RG-BLK-500', 'RG-YEL', 'QBHCO-100']);
});

test('a change delivered twice is written to the Sheet once', async () => {
  const server = await testServer();
  await server.post('saveCounts', saveCounts([countRow({ loosePieces: 7 })]));
  await server.drainSheet();
  // As if the server had stopped after the Sheet took the change, before it could note that.
  await server.db.update(sheetOutbox).set({ deliveredAt: null }).where(eq(sheetOutbox.id, 1));
  await server.drainSheet();

  expect(sheetCounts(server).filter((cells) => cells[1] === 'RG-BLK-500')).toHaveLength(1);
  expect((await server.queued())[0]).toMatchObject({ attempts: 2 });
});

test('a change the Sheet refuses for good is set aside and reported; later changes still go', async () => {
  const server = await testServer();
  // The database knows a place the Sheet does not list.
  await server.db.execute(sql`insert into locations (shop_id, name, position) values (${server.shopId}, 'Back room', 4)`);
  await server.post('saveCounts', saveCounts([countRow({ loosePieces: 2 })], { location: 'Back room' }));
  await server.post('saveCounts', saveCounts([countRow({ loosePieces: 3 })]));
  await server.drainSheet();

  const [refused, later] = await server.queued();
  expect(refused).toMatchObject({ deliveredAt: null, lastError: expect.stringContaining('invalid_request') });
  expect(refused?.failedAt).not.toBeNull();
  expect(later?.deliveredAt).not.toBeNull();
  expect(server.errors.join('\n')).toContain('The Sheet refused change 1');
  // The database has both; the Sheet has the one it could take.
  expect((await server.stockOf('RG-BLK-500')).total).toBe(5);
  expect(sheetCounts(server).filter((cells) => cells[1] === 'RG-BLK-500').map((cells) => cells[4])).toEqual([3]);
});

test('a server that starts while Google is down keeps the changes and sends them when it is back', async () => {
  const server = await testServer();
  server.state.sheetDown = true;
  await server.post('saveCounts', saveCounts([countRow({ loosePieces: 6 })]));
  await server.drainSheet();
  expect((await server.queued())[0]).toMatchObject({ attempts: 0, deliveredAt: null, failedAt: null });

  server.state.sheetDown = false;
  await server.drainSheet();
  expect((await server.queued())[0]?.deliveredAt).not.toBeNull();
});

test('an Apps Script that is not ready for this server is left alone until it is', async () => {
  const server = await testServer();
  const post = server.sheet.post;
  await server.post('saveCounts', saveCounts([countRow()]));

  // An older deployment knows nothing of the server's actions.
  server.sheet.post = (request) => (['serverInfo', 'mirror'].includes(String(request.action)) ? { ok: false, error: { code: 'invalid_request', message: 'Unknown action.' } } : post(request));
  await server.drainSheet();
  expect((await server.queued())[0]).toMatchObject({ attempts: 0, deliveredAt: null, failedAt: null });
  expect(server.errors.join('\n')).toContain('It needs the current Code.gs deployed as a new version, and SERVER_SECRET');

  // The current version, but the secret in its Script Properties is not this server's.
  server.sheet.post = (request) => post({ ...request, secret: 'not-the-secret-it-was-given' });
  await server.drainSheet();
  expect((await server.queued())[0]).toMatchObject({ attempts: 0, deliveredAt: null, failedAt: null });
  expect(server.errors.at(-1)).toContain('unauthorized');

  server.sheet.post = post;
  await server.drainSheet();
  expect((await server.queued())[0]?.deliveredAt).not.toBeNull();
});

test('when the Sheet\'s count rows are full the counts wait, in order, and arrive once rows are cleared', async () => {
  const server = await testServer();
  await server.drainSheet();
  const tab = server.sheet.workbook.get('Claude_Counts') as unknown as { write(row: number, column: number, value: unknown): void };
  // Every one of the 500 rows holds a count from an older stocktake.
  for (let row = 2; row <= 501; row++) { tab.write(row, 1, new Date(Date.UTC(2026, 0, 5))); tab.write(row, 3, 'RG-YEL'); }

  await server.post('saveCounts', saveCounts([countRow({ loosePieces: 4 })]));
  await server.post('adjust', adjustment({ quantity: 3 }));
  await server.drainSheet();

  // Not set aside: kept and tried again, with the hand entry waiting behind it.
  expect((await server.queued()).map((event) => [event.payload.kind, event.attempts, event.failedAt, event.deliveredAt])).toEqual([['counts', 1, null, null], ['adjustment', 0, null, null]]);
  expect(server.errors.join('\n')).toContain('sheet_full');
  expect((await server.stockOf('RG-BLK-500')).total).toBe(4);

  // The owner clears the old rows.
  for (let row = 2; row <= 501; row++) { tab.write(row, 1, ''); tab.write(row, 3, ''); }
  await makeDue(server);
  await server.drainSheet();
  expect((await server.queued()).every((event) => event.deliveredAt !== null)).toBe(true);
  expect(sheetCounts(server)).toEqual([['Shop shelf', 'RG-BLK-500', 0, '', 4, 'High', '[Ama] Clear single row.']]);
});

test('a product the Sheet has no room for is set aside, and the changes after it still go', async () => {
  const server = await testServer();
  const tab = server.sheet.workbook.get('Products') as unknown as { write(row: number, column: number, value: unknown): void };
  for (let row = 4; row <= 201; row++) tab.write(row, 1, `FULL-${row}`);

  await server.post('saveProduct', productSave());
  await server.post('adjust', adjustment({ quantity: 3 }));
  await server.drainSheet();

  const [product, entry] = await server.queued();
  expect(product).toMatchObject({ deliveredAt: null, lastError: expect.stringContaining('sheet_full') });
  expect(product?.failedAt).not.toBeNull();
  expect(entry?.deliveredAt).not.toBeNull();
  expect(await server.product('QBHGO-250')).toBeDefined();
});

test('on a host that only runs while it answers, a later request of any kind sends what was left over', async () => {
  const server = await testServer({ liveMirror: true });
  const callsToGoogle = () => server.state.sheetCalls.length;
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    // A save while Google cannot be reached: the save succeeds, and its change is left waiting.
    server.state.sheetDown = true;
    expect((await server.post('saveCounts', saveCounts([countRow({ loosePieces: 6 })]))).ok).toBe(true);
    await server.mirror.settled();
    expect((await server.queued())[0]).toMatchObject({ deliveredAt: null, failedAt: null });

    // Google is back. A request straight away does not try again yet: the worker waits a little.
    server.state.sheetDown = false;
    const before = callsToGoogle();
    await server.post('bootstrap');
    await server.mirror.settled();
    expect(callsToGoogle()).toBe(before);

    // A while later, opening the app is enough to send it. No clock was running in between.
    vi.setSystemTime(Date.now() + 20_000);
    await server.post('bootstrap');
    await server.mirror.settled();
    expect((await server.queued())[0]?.deliveredAt).not.toBeNull();

    // With nothing left, further requests do not touch Google at all.
    const after = callsToGoogle();
    await server.post('stock');
    await server.post('bootstrap');
    await server.mirror.settled();
    expect(callsToGoogle()).toBe(after);
  } finally {
    vi.useRealTimers();
  }
});

test('a save sets its own change going at once', async () => {
  const server = await testServer({ liveMirror: true });
  await server.post('adjust', adjustment({ quantity: 3 }));
  await server.mirror.settled();
  expect((await server.queued()).map((event) => [event.payload.kind, event.deliveredAt !== null])).toEqual([['adjustment', true]]);
});
