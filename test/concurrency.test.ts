import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { adjustment, countRow, noDetails, productSave, requestId, saveCounts, testServer } from './harness.ts';

// Many phones at once. Every test fires its requests together and then checks that the result is
// exactly what the same requests would give one after another.

const together = <T>(count: number, make: (index: number) => Promise<T>) => Promise.all(Array.from({ length: count }, (_, index) => make(index)));

test('one save arriving twenty times at the same moment is written exactly once', async () => {
  const server = await testServer();
  const save = saveCounts([countRow({ productCode: 'RG-YEL', loosePieces: 5 })]);

  const replies = await together(20, () => server.post('saveCounts', save));
  expect(replies.every((reply) => reply.ok)).toBe(true);
  expect(replies.filter((reply) => reply.data.duplicate === false)).toHaveLength(1);
  expect((await server.stockOf('RG-YEL')).total).toBe(8 + 5);
  expect(await server.queued()).toHaveLength(1);
});

test('forty phones counting the same listed product at once all save, and the stock is their exact sum', async () => {
  const server = await testServer();
  const replies = await together(40, (index) =>
    server.post('saveCounts', saveCounts([countRow({ productCode: 'RG-YEL', loosePieces: index + 1 }), countRow({ loosePieces: 2 })], { counter: `Phone ${index}` })));

  expect(replies.map((reply) => reply.error?.code ?? 'saved')).toEqual(new Array(40).fill('saved'));
  expect((await server.stockOf('RG-YEL')).total).toBe(8 + (40 * 41) / 2);
  expect((await server.stockOf('RG-BLK-500')).total).toBe(80);
});

test('phones that photograph the same new product at once create it once', async () => {
  const server = await testServer();
  const carrotOil = { ...noDetails, name: 'QBH Carrot Oil', size: '100ml' };
  const replies = await together(15, (index) =>
    server.post('saveCounts', saveCounts([countRow({ productCode: null, newProduct: carrotOil, loosePieces: 2 })], { counter: `Phone ${index}` })));

  expect(replies.map((reply) => reply.error?.code ?? 'saved')).toEqual(new Array(15).fill('saved'));
  const products = (await server.post('bootstrap')).data.products.filter((product: { name: string }) => product.name.startsWith('QBH Carrot Oil'));
  expect(products.map((product: { code: string }) => product.code)).toEqual(['QBHCO-100']);
  expect((await server.stockOf('QBHCO-100')).total).toBe(30);
});

test('different new products whose names give the same code each get their own code', async () => {
  const server = await testServer();
  const names = ['Glow Oil', 'Gentle Oil', 'Golden Oil', 'Ginger Oil', 'Grape Oil', 'Garlic Oil', 'Guava Oil', 'Green Oil'];
  const replies = await together(names.length, (index) => server.post('saveProduct', productSave({ name: `QBH ${names[index]}`, size: '250ml' })));

  expect(replies.map((reply) => reply.error?.code ?? 'saved')).toEqual(new Array(names.length).fill('saved'));
  const codes = (await server.post('bootstrap')).data.products.map((product: { code: string }) => product.code).filter((code: string) => code.startsWith('QBHGO'));
  expect(codes).toHaveLength(names.length);
  expect(new Set(codes).size).toBe(names.length);
});

test('the same new product added from the Products screen by several people at once is added once', async () => {
  const server = await testServer();
  const replies = await together(8, () => server.post('saveProduct', productSave({ name: 'QBH Shea Butter', size: '200g' })));

  expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
  expect(new Set(replies.filter((reply) => !reply.ok).map((reply) => reply.error?.message))).toEqual(new Set(['A product with this name already exists. Add the size or variant to the name to tell them apart.']));
});

test('of several people saving the same product from the same copy, one wins and the rest are told', async () => {
  const server = await testServer();
  const opened = (await server.product('RG-YEL')).version;
  const replies = await together(10, (index) => server.post('saveProduct', {
    requestId: requestId(), productVersion: opened,
    product: { ...noDetails, code: 'RG-YEL', name: 'Rich Glow Yellow Tone Lotion', brand: `Brand ${index}`, packSize: 12, reorderLevel: null },
  }));

  expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
  expect(replies.filter((reply) => reply.error?.code === 'conflict')).toHaveLength(9);
  const winner = replies.findIndex((reply) => reply.ok);
  expect(await server.product('RG-YEL')).toMatchObject({ brand: `Brand ${winner}`, version: String(Number(opened) + 1) });
});

test('counts that fill in details, an edit and hand entries on one product at once leave it consistent', async () => {
  const server = await testServer();
  const replies = await together(30, (index) => {
    if (index % 3 === 0) return server.post('saveCounts', saveCounts([countRow({ productCode: 'RG-YEL', loosePieces: 1, details: { ...noDetails, brand: 'Rich Glow', batchNumber: `B${index}` } })]));
    if (index % 3 === 1) return server.post('adjust', adjustment({ type: 'add', quantity: 2 }));
    return server.post('setPrice', { requestId: requestId(), productCode: 'RG-YEL', price: index, currency: 'GHS' });
  });

  expect(replies.map((reply) => reply.error?.code ?? 'saved')).toEqual(new Array(30).fill('saved'));
  expect((await server.stockOf('RG-YEL')).locations[0]).toMatchObject({ photoCount: 8 + 10, addRemove: 20, final: 38 });
  const product = await server.product('RG-YEL');
  // The brand and batch were empty once: one count filled each, and no later one replaced it.
  expect(product.brand).toBe('Rich Glow');
  expect(product.batchNumber).toMatch(/^B\d+$/);
  // Ten price changes and one fill of the details: eleven changes to the product, each counted.
  expect(product.version).toBe('12');
});

test('the daily photo limit holds exactly, however many photos arrive together', async () => {
  const server = await testServer({ dailyLimit: 5 });
  server.vision.answer = { items: [], photoNote: '' };
  const image = { data: 'aGVsbG8=', mediaType: 'image/jpeg' };

  const replies = await together(25, () => server.post('analyzeCount', { location: 'Shop shelf', image }));
  expect(replies.filter((reply) => reply.ok)).toHaveLength(5);
  expect(new Set(replies.filter((reply) => !reply.ok).map((reply) => reply.error?.code))).toEqual(new Set(['limit_reached']));
  expect(server.vision.questions).toHaveLength(5);
});

test('nothing is left half-written: every ledger row belongs to a claimed save', async () => {
  const server = await testServer();
  await together(30, (index) => server.post('saveCounts', saveCounts([
    countRow({ productCode: null, newProduct: { ...noDetails, name: `Product ${index % 5}`, size: '' }, loosePieces: 1 }),
    // Every third save is refused at its second row, after its first row was planned.
    countRow(index % 3 === 0 ? { productCode: 'GONE' } : {}),
  ])));

  const [orphans] = await server.db.execute(sql`
    select count(*)::int as n from photo_counts c where c.request_id <> 'sheet-import'
      and not exists (select 1 from handled_requests r where r.request_id = c.request_id)`) as unknown as { n: number }[];
  expect(orphans?.n).toBe(0);
  const [saved] = await server.db.execute(sql`select count(*)::int as n from handled_requests`) as unknown as { n: number }[];
  expect(saved?.n).toBe(20);
  expect((await server.post('bootstrap')).data.products.filter((product: { name: string }) => product.name.startsWith('Product '))).toHaveLength(5);
});
