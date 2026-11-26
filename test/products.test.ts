import { expect, test } from 'vitest';
import { PHOTO, driveLink, productSave, requestId, testServer } from './harness.ts';

const edit = (product: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  productSave({ code: 'RG-YEL', name: 'Rich Glow Yellow Tone Lotion', size: '', category: '', packSize: 12, reorderLevel: null, ...product }, overrides);

test('a new product gets a code, is saved once however often the save arrives, and cannot share a name', async () => {
  const server = await testServer();
  const save = productSave();

  expect(await server.post('saveProduct', save)).toEqual({ ok: true, data: { duplicate: false } });
  expect(await server.post('saveProduct', save)).toEqual({ ok: true, data: { duplicate: true } });
  expect(await server.product('QBHGO-250')).toMatchObject({ name: 'QBH Glycerin Oil', size: '250ml', packSize: 24, reorderLevel: 10, version: '1', price: null, currency: '' });

  const sameName = await server.post('saveProduct', productSave({ name: 'qbh  glycerin OIL', size: '500ml' }));
  expect(sameName.error).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('already exists') });
  // A different product whose letters give the same code gets the next free one.
  await server.post('saveProduct', productSave({ name: 'QBH Ginger Oil' }));
  expect(await server.product('QBHGO-250-2')).toMatchObject({ name: 'QBH Ginger Oil' });
});

test('an edit changes the details but never the name, and what is sent is checked', async () => {
  const server = await testServer();
  expect((await server.post('saveProduct', edit({ name: 'Renamed in the app', size: '500ml', barcode: '0123456789012', reorderLevel: 6 }))).ok).toBe(true);
  expect(await server.product('RG-YEL')).toMatchObject({ name: 'Rich Glow Yellow Tone Lotion', size: '500ml', barcode: '0123456789012', reorderLevel: 6, version: '2' });

  for (const [product, message] of [
    [{ barcode: '12ab' }, 'digits only'], [{ packSize: 2.5 }, 'whole number'], [{ expiry: '19/08/2030' }, 'YYYY-MM-DD'],
    [{ name: '' }, 'Enter the product name'], [{ code: 'GONE' }, 'no longer in the list'], [{ qrCode: 'a'.repeat(2001) }, 'too long'],
  ] as const) {
    expect((await server.post('saveProduct', edit(product))).error?.message, JSON.stringify(product)).toContain(message);
  }
  expect((await server.product('RG-YEL')).version).toBe('2');
});

test('an edit made from an older copy of a product is refused, whoever changed it meanwhile', async () => {
  const server = await testServer();
  const opened = (await server.product('RG-YEL')).version;

  expect((await server.post('saveProduct', edit({ brand: 'Rich Glow' }, { productVersion: opened }))).ok).toBe(true);
  const stale = await server.post('saveProduct', edit({ brand: '', variant: 'Yellow' }, { productVersion: opened, images: [PHOTO] }));
  expect(stale.error).toMatchObject({ code: 'conflict', message: expect.stringContaining('This product was changed after you opened it') });
  expect(await server.product('RG-YEL')).toMatchObject({ brand: 'Rich Glow', variant: '', imageUrls: [] });
  expect(server.sheet.recorded.driveFiles).toHaveLength(0);

  // A price set from the Adjustments screen is a change too.
  const beforePrice = (await server.product('RG-YEL')).version;
  await server.post('setPrice', { requestId: requestId(), productCode: 'RG-YEL', price: 30, currency: 'GHS' });
  expect((await server.post('saveProduct', edit({ brand: 'Rich Glow' }, { productVersion: beforePrice }))).error?.code).toBe('conflict');

  // Opened again, the change goes through. An older app sends no version and is not checked.
  expect((await server.post('saveProduct', edit({ brand: 'Rich Glow', variant: 'Yellow' }, { productVersion: (await server.product('RG-YEL')).version }))).ok).toBe(true);
  expect((await server.post('saveProduct', edit({ brand: 'Rich Glow', variant: 'Yellow' }))).ok).toBe(true);
  expect((await server.product('RG-YEL')).price).toBe(30);
});

test('a product keeps several photos in order; removed ones are named, and go to the Drive trash', async () => {
  const server = await testServer();
  await server.post('saveProduct', edit({}, { images: [PHOTO, PHOTO] }));
  expect(await server.product('RG-YEL')).toMatchObject({ imageUrls: [driveLink(1), driveLink(2)], imageUrl: driveLink(1) });

  // Another phone, still showing photos 1 and 2, removes photo 1 after a third was added elsewhere.
  await server.post('saveProduct', edit({}, { images: [PHOTO] }));
  await server.post('saveProduct', edit({}, { removeImageUrls: [driveLink(1), 'https://evil.example/x'], keepImageUrls: [driveLink(2)] }));
  expect((await server.product('RG-YEL')).imageUrls).toEqual([driveLink(2), driveLink(3)]);
  expect(server.sheet.recorded.driveUpdates).toEqual([{ fileId: 'file-1', trashed: true }]);

  // An older app sends the photos to keep, in its order; a link the product never had cannot be written in.
  await server.post('saveProduct', edit({}, { keepImageUrls: [driveLink(3), 'https://evil.example/x'] }));
  expect((await server.product('RG-YEL')).imageUrls).toEqual([driveLink(3)]);

  const tooMany = await server.post('saveProduct', edit({}, { images: new Array(7).fill(PHOTO) }));
  expect(tooMany.error?.message).toContain('at most 6 photos at a time');
  await server.post('saveProduct', edit({}, { images: new Array(6).fill(PHOTO) }));
  const overLimit = await server.post('saveProduct', edit({}, { images: new Array(4).fill(PHOTO) }));
  expect(overLimit.error?.message).toContain('up to 10 photos');
  expect(server.sheet.recorded.driveFiles).toHaveLength(9);
  expect((await server.product('RG-YEL')).imageUrls).toHaveLength(7);
});

test('photos stored for a save that then fails are removed again, and a resent save stores nothing twice', async () => {
  const server = await testServer();
  const opened = (await server.product('RG-YEL')).version;
  // Someone else changes the product while this save's photo is on its way to Drive.
  let once = true;
  server.sheet.recorded.whileUploading = () => {
    if (!once) return;
    once = false;
    void server.post('setPrice', { requestId: requestId(), productCode: 'RG-YEL', price: 5, currency: 'GHS' });
  };
  const racing = edit({ brand: 'Rich Glow' }, { productVersion: opened, images: [PHOTO] });
  // The price save lands first or second; either way exactly one version of the product results.
  const reply = await server.post('saveProduct', racing);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const product = await server.product('RG-YEL');
  if (reply.ok) expect(product).toMatchObject({ brand: 'Rich Glow', imageUrls: [driveLink(1)] });
  else {
    expect(reply.error?.code).toBe('conflict');
    expect(product).toMatchObject({ brand: '', imageUrls: [] });
    expect(server.sheet.recorded.driveUpdates).toEqual([{ fileId: 'file-1', trashed: true }]);
  }

  server.sheet.recorded.whileUploading = null;
  const save = productSave({}, { images: [PHOTO] });
  const filesBefore = server.sheet.recorded.driveFiles.length;
  expect((await server.post('saveProduct', save)).data).toEqual({ duplicate: false });
  expect((await server.post('saveProduct', save)).data).toEqual({ duplicate: true });
  expect(server.sheet.recorded.driveFiles).toHaveLength(filesBefore + 1);
});

test('a price is kept as whole minor units in its currency, and odd amounts are refused, not rounded', async () => {
  const server = await testServer();
  const price = (amount: unknown, currency?: unknown) => server.post('setPrice', { requestId: requestId(), productCode: 'RG-YEL', price: amount, currency });

  expect((await price(25.5, 'GHS')).ok).toBe(true);
  expect(await server.product('RG-YEL')).toMatchObject({ price: 25.5, currency: 'GHS' });
  expect((await price(19.99)).ok).toBe(true); // no currency means cedis
  expect(await server.product('RG-YEL')).toMatchObject({ price: 19.99, currency: 'GHS' });
  expect((await price(1500, 'XOF')).ok).toBe(true);
  expect(await server.product('RG-YEL')).toMatchObject({ price: 1500, currency: 'XOF' });

  expect((await price(1.999, 'GHS')).error?.message).toContain('at most 2 decimals');
  expect((await price(10.5, 'XOF')).error?.message).toContain('no decimals');
  expect((await price(-1, 'GHS')).error?.message).toContain('must be a number');
  expect((await price(5, 'JPY')).error?.message).toContain('Choose the currency');
  expect((await price(undefined)).error?.message).toContain('Enter the price');
  expect(await server.product('RG-YEL')).toMatchObject({ price: 1500, currency: 'XOF' });

  // An edit that sends no price leaves it alone; null clears it.
  await server.post('saveProduct', edit({ brand: 'Rich Glow' }));
  expect((await server.product('RG-YEL')).price).toBe(1500);
  expect((await price(null)).ok).toBe(true);
  expect(await server.product('RG-YEL')).toMatchObject({ price: null, currency: '' });
});

test('a deleted product leaves the list and the stock, and the same name added again starts from nothing', async () => {
  const server = await testServer();
  expect((await server.stockOf('RG-YEL')).total).toBe(8);

  expect((await server.post('deleteProduct', { requestId: requestId(), productCode: 'RG-YEL' })).ok).toBe(true);
  expect(await server.product('RG-YEL')).toBeUndefined();
  expect(await server.stockOf('RG-YEL')).toBeUndefined();
  expect((await server.post('bootstrap')).data.counted).toEqual([]);
  expect((await server.post('deleteProduct', { requestId: requestId(), productCode: 'RG-YEL' })).error?.message).toContain('no longer in the list');

  // The name is free again. The product that takes it is a new one, with nothing counted.
  await server.post('saveProduct', productSave({ name: 'Rich Glow Yellow Tone Lotion', size: '', packSize: null }));
  expect(await server.product('RGYTL')).toMatchObject({ name: 'Rich Glow Yellow Tone Lotion', version: '1' });
  expect((await server.stockOf('RGYTL')).total).toBe(0);
});
