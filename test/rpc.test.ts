import { expect, test } from 'vitest';
import { appContract } from './companion.ts';
import { SECRET, testServer } from './harness.ts';

test('a request without the right secret, or that makes no sense, is refused in the app\'s own format', async () => {
  const server = await testServer();
  const send = async (body: string) => {
    const response = await server.raw(body);
    return { status: response.status, ...(await response.json() as { ok: boolean; error?: { code: string } }) };
  };

  expect(await send(JSON.stringify({ action: 'bootstrap', secret: 'wrong' }))).toMatchObject({ status: 401, ok: false, error: { code: 'unauthorized' } });
  expect(await send(JSON.stringify({ action: 'bootstrap' }))).toMatchObject({ status: 401, error: { code: 'unauthorized' } });
  expect(await send(JSON.stringify({ action: 'formatDisk', secret: SECRET }))).toMatchObject({ status: 400, error: { code: 'invalid_request' } });
  expect(await send('not json')).toMatchObject({ status: 400, error: { code: 'invalid_request' } });
  expect(await send('')).toMatchObject({ status: 400, error: { code: 'invalid_request' } });
  // A prototype name is not an action.
  expect(await send(JSON.stringify({ action: 'constructor', secret: SECRET }))).toMatchObject({ status: 400 });
});

test('what the server sends when the app opens, and for the Stock screen, is what the app expects', async () => {
  const server = await testServer();

  // The app's own schemas: if the server and the app drift apart, this is where it shows.
  const { bootstrapSchema, stockSchema } = await appContract();
  const opened = bootstrapSchema.parse((await server.post('bootstrap')).data);
  expect(opened.countDate).toBe('2026-11-23');
  expect(opened.locations).toEqual(['Shop shelf', 'Warehouse bags', 'Warehouse sacks']);
  expect(opened.products.map((product: { code: string }) => product.code)).toEqual(['RG-BLK-500', 'RG-YEL']);
  expect(opened.counted).toEqual([{ code: 'RG-YEL', location: 'Shop shelf', pieces: 8 }]);
  expect(opened.currencies[0]).toEqual({ code: 'GHS', name: 'Ghana cedi', shortName: 'GH₵', decimals: 2 });
  expect(opened.actions).toEqual(expect.arrayContaining(['saveCounts', 'saveProduct', 'deleteProduct', 'setPrice', 'adjust']));
  expect(opened.photoSetLimit).toBe(4);
  expect(opened.countViewLimit).toBe(8);
  expect(opened.productPhotoLimit).toBe(10);

  const stock = stockSchema.parse((await server.post('stock')).data);
  expect(stock.rows.map((row: { code: string }) => row.code)).toEqual(['RG-BLK-500', 'RG-YEL']);
});

test('the address answers a browser, and the health check asks the database', async () => {
  const server = await testServer();
  expect(await (await server.app.request('/')).json()).toEqual({ ok: true, data: { service: 'stock-count' } });
  expect((await server.app.request('/health')).status).toBe(200);
});
