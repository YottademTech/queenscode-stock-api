import { expect, test } from 'vitest';
import { importSheet, sheetExportSchema, type SheetExport } from '../src/sheet/import.ts';
import { adjustment, countRow, saveCounts, testServer } from './harness.ts';

const sheetData = (overrides: Partial<SheetExport> = {}): SheetExport => sheetExportSchema.parse({
  countDate: '2026-12-01',
  locations: ['Shop shelf', 'Store room'],
  currencies: [{ code: 'GHS', name: 'Ghana cedi', shortName: 'GH₵', decimals: 2 }],
  products: [
    { code: 'B-2', name: 'Second in the Sheet', packSize: null, reorderLevel: 5, imageUrls: ['https://drive.google.com/file/d/a/view'], price: 12.5, currency: 'GHS' },
    { code: 'A-1', name: 'First by code', size: '100ml', packSize: 10, reorderLevel: null },
  ],
  counts: [
    { countDate: '2026-11-23', location: 'Shop shelf', code: 'A-1', fullCartons: 1, packSize: null, loosePieces: 1, confidence: 'High', note: '[Ama] Earlier stocktake.' },
    { countDate: '2026-12-01', location: 'Store room', code: 'A-1', fullCartons: 0, packSize: null, loosePieces: 4, confidence: 'Low', note: 'Typed by hand' },
    { countDate: '2026-12-01', location: 'Shop shelf', code: 'TESTPDM-1', fullCartons: 0, packSize: null, loosePieces: 9, confidence: 'High', note: '' },
  ],
  adjustments: [
    { at: '2026-12-01T10:00:00.000Z', counter: 'Ama', countDate: '2026-12-01', location: 'Store room', productName: 'first BY code', type: 'correct', quantity: 7, reason: '' },
    { at: '2026-12-01T09:00:00.000Z', counter: 'Ama', countDate: '2026-12-01', location: 'Store room', productName: 'First by code', type: 'correct', quantity: 99, reason: 'Earlier, replaced' },
    { at: '2026-12-01T11:00:00.000Z', counter: 'Ama', countDate: '2026-12-01', location: 'Store room', productName: 'Nobody', type: 'add', quantity: 1, reason: '' },
  ],
  ...overrides,
});

test('the database starts from the Sheet: places, products in the Sheet\'s order, and every count under its own stocktake', async () => {
  const server = await testServer();
  const summary = await importSheet(server.db, server.shopId, sheetData(), true);

  expect(summary).toMatchObject({ products: 2, counts: 2, adjustments: 2 });
  // Rows that point at nothing are reported, not guessed at.
  expect(summary.skipped).toEqual([
    'Count row 3 (TESTPDM-1 at Shop shelf): no such product.',
    'Hand entry 3 (Nobody at Store room): no such product.',
  ]);

  const opened = (await server.post('bootstrap')).data;
  expect(opened).toMatchObject({ countDate: '2026-12-01', locations: ['Shop shelf', 'Store room'] });
  expect(opened.products.map((product: { code: string }) => product.code)).toEqual(['B-2', 'A-1']);
  expect(opened.products[0]).toMatchObject({ price: 12.5, currency: 'GHS', imageUrl: 'https://drive.google.com/file/d/a/view' });
  // Only the open stocktake counts: 4 by photo, replaced by the latest correction, 7.
  expect(await server.stockOf('A-1')).toMatchObject({ total: 7, photoTotal: 4, review: '' });
  expect(await server.queued()).toHaveLength(0);
});

test('importing over existing products is refused unless asked for, and a failed import changes nothing', async () => {
  const server = await testServer();
  await server.post('saveCounts', saveCounts([countRow({ loosePieces: 6 })]));
  await server.post('adjust', adjustment());

  await expect(importSheet(server.db, server.shopId, sheetData(), false)).rejects.toThrow('already has products');
  const broken = sheetData();
  broken.products.push({ ...broken.products[0], code: 'C-3' } as SheetExport['products'][number]);
  await expect(importSheet(server.db, server.shopId, broken, true)).rejects.toThrow();
  expect((await server.stockOf('RG-BLK-500')).total).toBe(6);

  await importSheet(server.db, server.shopId, sheetData(), true);
  expect(await server.stockOf('RG-BLK-500')).toBeUndefined();
  expect((await server.post('bootstrap')).data.products).toHaveLength(2);
});

test('what the Sheet could not hand over is listed, and stock added by hand without a timestamp still counts', async () => {
  const server = await testServer();
  const data = sheetData({
    adjustments: [
      { at: '', counter: '', countDate: '2026-12-01', location: 'Store room', productName: 'First by code', type: 'add', quantity: 5, reason: 'typed in the Sheet' },
      { at: '2026-12-01T10:00:00.000Z', counter: 'Ama', countDate: '2026-12-01', location: 'Store room', productName: 'First by code', type: 'remove', quantity: 1, reason: '' },
    ],
    leftOut: [{ tab: 'Form_Adjustments', row: 6, why: 'its quantity is not a whole number' }],
  });
  const summary = await importSheet(server.db, server.shopId, data, true);

  expect(summary.skipped).toContain('Form_Adjustments row 6: its quantity is not a whole number.');
  // 4 by photo in the store room, plus 5, less 1.
  expect((await server.stockOf('A-1')).locations.find((place: { location: string }) => place.location === 'Store room')).toMatchObject({ photoCount: 4, addRemove: 4, final: 8 });
});

test('a save the Apps Script had already written is not written again when the phone resends it to the server', async () => {
  const server = await testServer();
  await importSheet(server.db, server.shopId, sheetData({ handledRequests: [{ id: 'phone-save-0001', action: 'saveCounts' }, { id: 'phone-save-0002', action: 'adjust' }] }), true);
  const before = (await server.stockOf('A-1')).total;

  // The phone never heard back from the Apps Script, so it sends the same save to the server.
  const resent = await server.post('saveCounts', { requestId: 'phone-save-0001', location: 'Shop shelf', counter: 'Ama', rows: [countRow({ productCode: 'A-1', loosePieces: 9 })] });
  expect(resent).toEqual({ ok: true, data: { duplicate: true } });
  expect((await server.stockOf('A-1')).total).toBe(before);
  // A save the Sheet never saw goes through.
  expect((await server.post('saveCounts', { requestId: 'phone-save-0003', location: 'Shop shelf', counter: 'Ama', rows: [countRow({ productCode: 'A-1', loosePieces: 9 })] })).data).toEqual({ duplicate: false });
});

test('starting over from the Sheet drops the changes still waiting to be copied to it', async () => {
  const server = await testServer();
  server.state.sheetDown = true;
  await server.post('saveCounts', saveCounts([countRow({ loosePieces: 6 })]));
  expect((await server.queued()).filter((event) => event.deliveredAt === null && event.failedAt === null)).toHaveLength(1);

  await importSheet(server.db, server.shopId, sheetData(), true);
  server.state.sheetDown = false;
  await server.drainSheet();

  const [dropped] = await server.queued();
  expect(dropped).toMatchObject({ deliveredAt: null, lastError: 'Dropped: the database was started over from the Sheet.' });
  expect(server.state.sheetCalls.filter((action) => action === 'mirror')).toHaveLength(0);
});
