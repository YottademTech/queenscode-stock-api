import { runInContext } from 'node:vm';
import { expect, test } from 'vitest';
import { appContract } from './companion.ts';

const { countAnalysisSchema, labelReadingSchema } = await appContract();
import { AppError } from '../src/errors.ts';
import { photoBlocks } from '../src/vision/model.ts';
import * as prompts from '../src/vision/prompts.ts';
import { PHOTO, noDetails, testServer } from './harness.ts';

const item = (overrides: Record<string, unknown> = {}) => ({
  ...noDetails, otherDetails: [], productCode: 'RG-BLK-500', fullCartons: 0, packSize: 0, loosePieces: 11, confidence: 'Low', note: 'Back row hidden; 10 to 12.', ...overrides,
});

test('a count photo is sent to Claude with the place and the product list, and nothing is saved', async () => {
  const server = await testServer();
  server.vision.answer = { photoNote: 'One shelf.', items: [item()] };

  const reply = await server.post('analyzeCount', { location: 'Warehouse bags', image: PHOTO });
  const analysis = countAnalysisSchema.parse(reply.data);
  expect(analysis.items[0]).toMatchObject({ productCode: 'RG-BLK-500', loosePieces: 11, packSize: null, confidence: 'Low' });

  const [question] = server.vision.questions;
  expect(question?.question).toBe('Location: Warehouse bags\n\nProduct list:\nRG-BLK-500 | Rich Glow Advanced Whitening Lotion (Black) | 500ml\nRG-YEL | Rich Glow Yellow Tone Lotion | size unknown\n\nCount the stock in this photo.');
  expect(question).toMatchObject({ effort: 'high', images: [PHOTO], views: 1 });
  expect((question?.schema as { required: string[] }).required).toEqual(['items', 'photoNote']);
  expect((await server.stockOf('RG-BLK-500')).total).toBe(0);
});

test('detail photos go in the same request, with the guide that says how to use them', async () => {
  const server = await testServer();
  server.vision.answer = { photoNote: '', items: [] };
  await server.post('analyzeCount', { location: 'Shop shelf', images: [PHOTO, PHOTO, PHOTO] });

  const [question] = server.vision.questions;
  expect(question?.images).toHaveLength(3);
  expect(question?.question).toContain('Detail photos were added');
  expect(question?.question).toContain('record the details shown in all 3 photos.');

  expect((await server.post('analyzeCount', { location: 'Shop shelf', images: new Array(5).fill(PHOTO) })).error?.message).toContain('Send 1 to 4 photos');
  expect((await server.post('analyzeCount', { location: 'Shop shelf', image: { data: 'x', mediaType: 'application/pdf' } })).error?.message).toContain('JPEG, PNG or WebP');
  expect((await server.post('analyzeCount', { location: 'Nowhere', image: PHOTO })).error?.message).toContain('Choose a valid location');
});

test('what Claude answers is not trusted: unknown codes, bad barcodes, odd numbers and overlong text are put right', async () => {
  const server = await testServer();
  server.vision.answer = {
    photoNote: 'x'.repeat(400),
    items: [
      item({ productCode: 'INVENTED-1', name: 'New thing', barcode: '6034000123457', expiry: 'soon', loosePieces: -4, fullCartons: 2.6, packSize: 24, confidence: 'Certain', qrCode: 'https://guessed.example' }),
      item({ productCode: 'unknown', barcode: '0603400012347', expiry: '2030-08', otherDetails: [{ label: 'Claim', value: 'Alcohol free' }, { label: '', value: 'Shake well' }, { label: 'Empty', value: '' }] }),
      'not an item',
    ],
  };
  const { items, photoNote } = (await server.post('analyzeCount', { location: 'Shop shelf', image: PHOTO })).data;

  expect(photoNote).toHaveLength(300);
  expect(items).toHaveLength(2);
  // A barcode that fails its check digit is dropped: a misread would look real.
  expect(items[0]).toMatchObject({ productCode: null, barcode: '', expiry: '', loosePieces: 0, fullCartons: 3, packSize: 24, confidence: 'Low', qrCode: '' });
  expect(items[1]).toMatchObject({ productCode: null, barcode: '0603400012347', expiry: '2030-08', otherDetails: 'Claim: Alcohol free\nShake well' });

  server.vision.answer = 'nonsense';
  expect((await server.post('analyzeCount', { location: 'Shop shelf', image: PHOTO })).error?.code).toBe('claude_unavailable');
});

test('a product label is read into the details, and a failure of the reader reaches the app as its own kind', async () => {
  const server = await testServer();
  server.vision.answer = { ...noDetails, name: 'QBH Rose Water Toner', size: '200ml', otherDetails: [{ label: 'Claim', value: 'Alcohol free' }], note: 'Batch number blurred.' };
  const reading = labelReadingSchema.parse((await server.post('readProductLabel', { image: PHOTO })).data);
  expect(reading).toMatchObject({ name: 'QBH Rose Water Toner', otherDetails: 'Claim: Alcohol free', note: 'Batch number blurred.', qrCode: '' });
  expect(server.vision.questions[0]).toMatchObject({ effort: 'medium', question: 'Read this product photo.' });

  server.vision.failure = new AppError('claude_unavailable', 'The photo reader is busy or unreachable. Wait a moment and try again.');
  expect((await server.post('readProductLabel', { image: PHOTO })).error).toEqual({ code: 'claude_unavailable', message: 'The photo reader is busy or unreachable. Wait a moment and try again.' });
});

test('stock taken as a video is sent as several views of the same stock, with how to count from them', async () => {
  const server = await testServer();
  server.vision.answer = { photoNote: '', items: [item({ loosePieces: 12, confidence: 'High', note: 'View 2 shows 3 rows of 4.' })] };
  const view = (name: string) => ({ data: Buffer.from(name).toString('base64'), mediaType: 'image/jpeg' });
  const [front, above, side, label] = [view('front'), view('above'), view('side'), view('label close-up')];

  // The views alone: this is what the app asks for as soon as the video ends.
  const counted = await server.post('analyzeCount', { location: 'Shop shelf', images: [front, above, side], countViews: 3 });
  expect(countAnalysisSchema.parse(counted.data).items[0]).toMatchObject({ loosePieces: 12, note: 'View 2 shows 3 rows of 4.' });
  const [alone] = server.vision.questions;
  expect(alone).toMatchObject({ views: 3, images: [front, above, side], effort: 'high' });
  expect(alone?.question).toMatch(/^Location: Shop shelf\n\nProduct list:\nRG-BLK-500 \| /);
  expect(alone?.question).toContain('Several views of the same stock');
  expect(alone?.question).toContain('Never add up the counts of two views');
  expect(alone?.question).toMatch(/Count the stock shown in views 1 to 3\.$/);
  expect(alone?.question).not.toContain('Detail photos were added');

  // Then the views with a close-up of one item.
  await server.post('analyzeCount', { location: 'Shop shelf', images: [front, above, side, label], countViews: 3 });
  const whole = server.vision.questions[1];
  expect(whole).toMatchObject({ views: 3, images: [front, above, side, label] });
  expect(whole?.question).toContain('Count from the views only');
  expect(whole?.question).toMatch(/Count the stock shown in views 1 to 3 and record the details shown in the detail photo\.$/);
});

test('the number of views and of detail photos is bounded, and an app from before video counting is unaffected', async () => {
  const server = await testServer();
  server.vision.answer = { photoNote: '', items: [] };
  const send = (count: number, countViews?: unknown) => server.post('analyzeCount', { location: 'Shop shelf', images: new Array(count).fill(PHOTO), countViews });

  expect((await server.post('bootstrap')).data.countViewLimit).toBe(8);
  for (const [count, views, message] of [
    [9, 9, 'A count takes 1 to 8 views'], [3, 0, 'A count takes 1 to 8 views'], [3, 2.5, 'A count takes 1 to 8 views'], [3, '3', 'A count takes 1 to 8 views'],
    [2, 3, 'Send the 3 views of the stock, and up to 3 photos for details'], [12, 8, 'Send the 8 views of the stock, and up to 3 photos for details'],
    // Without countViews the old limit holds: five photos are still refused.
    [5, undefined, 'Send 1 to 4 photos'],
  ] as const) {
    expect((await send(count, views)).error?.message, `${count} photos, ${String(views)} views`).toContain(message);
  }
  expect(server.vision.questions).toHaveLength(0);

  // Eight views and three detail photos is the most, and it goes through.
  expect((await send(11, 8)).ok).toBe(true);
  expect(server.vision.questions[0]?.question).toMatch(/record the details shown in the 3 detail photos\.$/);
});

test('each photo is named for Claude by what it is: a view of the stock, or a detail photo', () => {
  const labels = (count: number, views: number) => photoBlocks(new Array(count).fill(PHOTO), views).flatMap((block) => (block.type === 'text' ? [block.text] : []));

  expect(labels(1, 1)).toEqual([]);
  expect(labels(3, 1)).toEqual(['Photo 1, the count photo:', 'Photo 2, a detail photo:', 'Photo 3, a detail photo:']);
  expect(labels(4, 3)).toEqual(['View 1 of 3 of the stock:', 'View 2 of 3 of the stock:', 'View 3 of 3 of the stock:', 'Detail photo 1:']);
  expect(photoBlocks([PHOTO, PHOTO], 2).filter((block) => block.type === 'image')).toHaveLength(2);
});

test('the wording Claude is given is the same in this server and in the Apps Script', async () => {
  // Until the Apps Script is retired the instructions live in two files. They must not drift apart.
  const server = await testServer();
  const inAppsScript = (name: string) => runInContext(name, server.sheet.context as object) as string;
  for (const name of ['COUNT_INSTRUCTIONS', 'LABEL_INSTRUCTIONS', 'DETAIL_PHOTOS_GUIDE', 'VIEWS_GUIDE', 'VIEWS_DETAIL_PHOTOS_GUIDE'] as const) {
    expect(prompts[name], name).toBe(inAppsScript(name));
  }
});
