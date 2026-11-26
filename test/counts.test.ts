import { runInContext } from 'node:vm';
import { expect, test } from 'vitest';
import { makeProductCode, uniqueProductName } from '../src/catalog/names.ts';
import { adjustment, countRow, noDetails, saveCounts, testServer } from './harness.ts';

const carrotOil = { ...noDetails, name: 'QBH Carrot Oil', size: '100ml', category: 'Hair oil', barcode: '0603400012347' };

test('counts of listed products are saved once, and add up in the stock', async () => {
  const server = await testServer();
  const save = saveCounts([countRow({ loosePieces: 5 }), countRow({ productCode: 'RG-YEL', fullCartons: 2, loosePieces: 3, confidence: 'Low' })]);

  expect(await server.post('saveCounts', save)).toEqual({ ok: true, data: { duplicate: false } });
  expect(await server.post('saveCounts', save)).toEqual({ ok: true, data: { duplicate: true } });

  // RG-YEL: 8 from before, plus 2 packs of 12 and 3 loose.
  expect(await server.stockOf('RG-YEL')).toMatchObject({ total: 35, photoTotal: 35, difference: 0, review: 'CHECK', status: 'Set reorder level' });
  expect((await server.stockOf('RG-BLK-500')).locations[0]).toEqual({ location: 'Shop shelf', photoCount: 5, correction: null, addRemove: 0, final: 5 });
  expect((await server.post('bootstrap')).data.counted).toEqual(expect.arrayContaining([{ code: 'RG-YEL', location: 'Shop shelf', pieces: 35 }]));
});

test('a product Claude did not recognise is created once, even when several rows show it', async () => {
  const server = await testServer();
  const reply = await server.post('saveCounts', saveCounts([
    countRow({ productCode: null, newProduct: carrotOil, fullCartons: 1, packSize: 24, loosePieces: 2 }),
    countRow({ productCode: null, newProduct: { ...carrotOil, barcode: '' }, loosePieces: 4 }),
    // The same name in another size is another product, told apart by its name.
    countRow({ productCode: null, newProduct: { ...carrotOil, size: '250ml' }, loosePieces: 1 }),
  ]));
  expect(reply).toEqual({ ok: true, data: { duplicate: false } });

  const products = (await server.post('bootstrap')).data.products.map((product: { code: string; name: string }) => [product.code, product.name]);
  expect(products.slice(2)).toEqual([['QBHCO-100', 'QBH Carrot Oil'], ['QBHCO-250', 'QBH Carrot Oil 250ml']]);
  expect(await server.product('QBHCO-100')).toMatchObject({ barcode: '0603400012347', packSize: 24, category: 'Hair oil' });
  expect((await server.stockOf('QBHCO-100')).total).toBe(30);
  expect((await server.stockOf('QBHCO-250')).total).toBe(1);

  // Counted again later, the label matches the product that now exists.
  await server.post('saveCounts', saveCounts([countRow({ productCode: null, newProduct: carrotOil, loosePieces: 3 })], { location: 'Warehouse bags' }));
  expect((await server.post('bootstrap')).data.products).toHaveLength(4);
  expect((await server.stockOf('QBHCO-100')).total).toBe(33);
});

test('details read from the photos fill only what is empty, and never the name', async () => {
  const server = await testServer();
  await server.post('saveCounts', saveCounts([
    countRow({ productCode: 'RG-YEL', confidence: 'Low', details: { ...noDetails, name: 'Something else', size: '400ml', barcode: '0603400012347', brand: 'Rich Glow' } }),
    countRow({ productCode: 'RG-YEL', details: { ...noDetails, size: '500ml', batchNumber: 'L2291' } }),
  ]));
  expect(await server.product('RG-YEL')).toMatchObject({
    name: 'Rich Glow Yellow Tone Lotion', size: '400ml', barcode: '0603400012347', brand: 'Rich Glow', batchNumber: 'L2291', version: '2',
  });
  // A count without details changes nothing about the product.
  await server.post('saveCounts', saveCounts([countRow({ productCode: 'RG-YEL' })]));
  expect((await server.product('RG-YEL')).version).toBe('2');
});

test('a save that cannot be right is refused whole: nothing of it is written', async () => {
  const server = await testServer();
  const before = (await server.post('stock')).data;

  for (const [rows, overrides, message] of [
    [[countRow(), countRow({ productCode: 'GONE' })], {}, 'Row 2: that product is no longer in the list'],
    [[countRow({ productCode: null, newProduct: carrotOil }), countRow({ fullCartons: 2 })], {}, 'Row 2: enter how many pieces'],
    [[countRow({ loosePieces: -1 })], {}, 'whole number'],
    [[countRow({ confidence: 'Sure' })], {}, 'Choose a valid Row 1 confidence'],
    [[countRow()], { location: 'Elsewhere' }, 'Choose a valid location'],
    [[countRow()], { counter: ' ' }, 'Enter the counter name'],
    [[], {}, 'no rows to save'],
    [new Array(61).fill(countRow()), {}, 'at most 60 rows'],
    [[countRow()], { requestId: 'short' }, 'no valid request ID'],
  ] as const) {
    const reply = await server.post('saveCounts', saveCounts([...rows], overrides));
    expect(reply.error?.message, message).toContain(message);
  }
  expect((await server.post('stock')).data).toEqual(before);
  expect((await server.post('bootstrap')).data.products).toHaveLength(2);
  expect(await server.queued()).toHaveLength(0);
});

test('a correction by hand replaces the photo count, the latest one wins, and stock added or removed goes on top', async () => {
  const server = await testServer();
  const shelf = async () => (await server.stockOf('RG-YEL')).locations[0];

  await server.post('adjust', adjustment({ type: 'add', quantity: 4 }));
  await server.post('adjust', adjustment({ type: 'remove', quantity: 1 }));
  expect(await shelf()).toEqual({ location: 'Shop shelf', photoCount: 8, correction: null, addRemove: 3, final: 11 });

  await server.post('adjust', adjustment({ quantity: 20 }));
  const second = adjustment({ quantity: 10 });
  await server.post('adjust', second);
  expect((await server.post('adjust', second)).data).toEqual({ duplicate: true });
  expect(await shelf()).toEqual({ location: 'Shop shelf', photoCount: 8, correction: 10, addRemove: 3, final: 13 });

  // Another place is its own figure.
  await server.post('adjust', adjustment({ location: 'Warehouse sacks', type: 'add', quantity: 30 }));
  expect(await server.stockOf('RG-YEL')).toMatchObject({ total: 43, photoTotal: 8, difference: 35 });

  expect((await server.post('adjust', adjustment({ productCode: 'GONE' }))).error?.message).toContain('no longer in the list');
  expect((await server.post('adjust', adjustment({ type: 'steal' }))).error?.message).toContain('adjustment type');
  expect((await server.post('adjust', adjustment({ quantity: 1.5 }))).error?.message).toContain('whole number');
});

test('CHECK shows for a Low count until someone corrects it; REORDER at or below the reorder level', async () => {
  const server = await testServer();
  await server.post('saveProduct', { requestId: 'reorder-level-0001', product: { ...noDetails, code: 'RG-YEL', name: 'x', packSize: 12, reorderLevel: 10 } });
  expect(await server.stockOf('RG-YEL')).toMatchObject({ total: 8, status: 'REORDER', review: '' });

  await server.post('saveCounts', saveCounts([countRow({ productCode: 'RG-YEL', loosePieces: 3, confidence: 'Low' })], { location: 'Warehouse bags' }));
  expect(await server.stockOf('RG-YEL')).toMatchObject({ total: 11, status: 'OK', review: 'CHECK' });

  await server.post('adjust', adjustment({ quantity: 10 }));
  expect(await server.stockOf('RG-YEL')).toMatchObject({ total: 13, status: 'OK', review: '' });
});

test('a second size whose name would be too long is refused, never cut into a name another product has', async () => {
  const server = await testServer();
  const longName = `QBH ${'Very Long Product Name '.repeat(5).trim()}`;
  expect(longName).toHaveLength(118);
  await server.post('saveProduct', { requestId: 'long-name-0001', product: { ...noDetails, code: null, name: longName, size: '250ml', packSize: null, reorderLevel: null } });

  for (let i = 0; i < 2; i++) {
    const reply = await server.post('saveCounts', saveCounts([countRow({ productCode: null, newProduct: { ...noDetails, name: longName, size: '500ml' } })]));
    expect(reply.error).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('Shorten the name to 114 characters or fewer') });
  }
  const names = (await server.post('bootstrap')).data.products.map((product: { name: string }) => product.name);
  expect(new Set(names).size).toBe(names.length);
  expect(names).toHaveLength(3);
});

test('codes and names are made by the same rule here and in the Apps Script, and never as something Sheets rewrites', async () => {
  const server = await testServer();
  const inAppsScript = <T>(name: string) => runInContext(name, server.sheet.context as object) as T;
  const theirCode = inAppsScript<typeof makeProductCode>('makeProductCode');
  const theirName = inAppsScript<typeof uniqueProductName>('uniqueProductName');

  // SEP-30 would become 30 September in a Sheet cell, and 247S-100 or 1E-5 a number.
  expect(makeProductCode('Shea Essence Perfume', '30ml', [])).toBe('P-SEP-30');
  expect(makeProductCode('24 7 Serum', '100ml', [])).toBe('P-247S-100');
  expect(makeProductCode('QBH Rose Water', '200ml', ['QBHRW-200'])).toBe('QBHRW-200-2');

  const listed = [{ name: 'QBH Carrot Oil', size: '100ml' }, { name: 'x'.repeat(120), size: '5ml' }];
  for (const [name, size] of [
    ['Shea Essence Perfume', '30ml'], ['24 7 Serum', '100ml'], ['MAY', '5ml'], ['MAY Cream', '5ml'], ['1 E', '5g'], ['True', ''], ['TRUE', '1L'],
    ['QBH Carrot Oil', '250ml'], ['QBH Carrot Oil', ''], ['x'.repeat(120), '500ml family size'], ['!!!', ''], ['December Glow', '12ml'], ['DEC', '12'],
  ] as const) {
    for (const taken of [[], ['P-SEP-30', 'QBHCO-250', 'ITEM']]) {
      expect(makeProductCode(name, size, taken), `code for "${name}" ${size}`).toBe(theirCode(name, size, taken));
    }
    // The same name, or the same refusal, from both.
    const outcome = (make: () => string) => { try { return make(); } catch (error) { return `refused: ${(error as Error).message}`; } };
    expect(outcome(() => uniqueProductName(listed, { name, size })), `name for "${name}" ${size}`).toBe(outcome(() => theirName(listed, { name, size })));
  }
});
