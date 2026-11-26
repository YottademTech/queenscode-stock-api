import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { sheetOutbox } from '../src/db/schema.ts';
import type { Deps } from '../src/deps.ts';
import { drivePhotoStore, type EncodedImage } from '../src/photos/store.ts';
import { enqueueSheetEvent, type SheetEvent } from '../src/sheet/events.ts';
import { GatewayUnreachable, type GatewayReply, type SheetGateway } from '../src/sheet/gateway.ts';
import { importSheet, sheetExportSchema } from '../src/sheet/import.ts';
import { startSheetMirror } from '../src/sheet/worker.ts';
import { ensureShop } from '../src/shop/setup.ts';
import { appsScriptFakes } from './companion.ts';
import type { VisionQuestion } from '../src/vision/model.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://stock:stock@127.0.0.1:54329/stock_test';
export const SECRET = 'server-test-secret-0123456789';
export const PHOTO: EncodedImage = { data: Buffer.from('fake jpeg bytes').toString('base64'), mediaType: 'image/jpeg' };
export const driveLink = (n: number) => `https://drive.google.com/file/d/file-${n}/view`;

/** A reply as the app receives it. Loose on purpose: tests assert on the parts they are about. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TestReply = { ok: boolean; data?: any; error?: { code: string; message: string } };

type SheetFake = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  post(request: Record<string, unknown>): any;
  context: { setup(): string };
  workbook: Map<string, { rowValues(row: number, columns: number): unknown[] }>;
  recorded: { driveFiles: unknown[]; driveUpdates: { fileId: string }[]; whileUploading: (() => void) | null };
  /** What the server sends to open the Apps Script's server-only actions. */
  serverSecret: string;
};

/**
 * The real Apps Script (apps-script/Code.gs) running on its in-memory stand-ins for the Sheet and
 * Drive. The server under test talks to it exactly as it talks to Google, so these tests cover
 * both halves together.
 */
async function sheetFake(options: Record<string, unknown> = {}): Promise<SheetFake> {
  const fakes = await appsScriptFakes();
  const backend = fakes.loadBackend(options) as SheetFake;
  backend.context.setup();
  backend.serverSecret = fakes.SERVER_SECRET as string;
  return backend;
}

let shared: ReturnType<typeof openDatabase> | null = null;

/**
 * A server on an emptied database, started from the stand-in Sheet: two products (RG-BLK-500, and
 * RG-YEL with 12 pieces per pack) and one photo count of 8 RG-YEL on the shop shelf, in the
 * stocktake of 2026-11-23.
 */
export async function testServer(options: { dailyLimit?: number; requestLimit?: number; liveMirror?: boolean; sheetOptions?: Record<string, unknown> } = {}) {
  shared ??= openDatabase(TEST_DATABASE_URL, 20);
  const db: Database = shared.db;
  await db.execute(sql`truncate table photo_counts, adjustments, product_photos, products, stocktakes, locations, shops, currencies,
    handled_requests, sheet_outbox, claude_usage restart identity cascade`);

  const sheet = await sheetFake(options.sheetOptions);
  const state = { sheetDown: false, sheetCalls: [] as string[] };
  const gateway: SheetGateway = {
    async call(action, payload): Promise<GatewayReply> {
      state.sheetCalls.push(action);
      if (state.sheetDown) throw new GatewayUnreachable('The Apps Script could not be reached: test.');
      return sheet.post({ ...payload, action, secret: sheet.serverSecret }) as GatewayReply;
    },
  };

  const shopId = await ensureShop(db, { slug: 'main', name: 'Test shop', timeZone: 'Africa/Accra' });
  await importSheet(db, shopId, sheetExportSchema.parse(sheet.post({ action: 'exportAll', secret: sheet.serverSecret }).data), false);

  const vision = { questions: [] as VisionQuestion[], answer: {} as unknown, failure: null as Error | null };
  const errors: string[] = [];
  const mirror = startSheetMirror(db, gateway, { info: () => {}, error: (message) => errors.push(message) });

  const deps: Deps = {
    db,
    config: { APP_SECRET: SECRET, SHOP_SLUG: 'main', CLAUDE_DAILY_CALL_LIMIT: options.dailyLimit ?? 1500, REQUEST_LIMIT_BYTES: options.requestLimit ?? 24 * 1024 * 1024 },
    vision: {
      async ask(question) {
        vision.questions.push(question);
        if (vision.failure) throw vision.failure;
        return vision.answer;
      },
    },
    photos: drivePhotoStore(gateway),
    // Events are queued as in production; a test sends them when it calls `drainSheet`. With
    // `liveMirror` the worker is wired in as on a real host, and requests set it going themselves.
    mirror: options.liveMirror ? mirror : { enqueue: enqueueSheetEvent, kick: () => {}, nudge: () => {} },
    log: { info: () => {}, error: (message) => errors.push(message) },
  };
  const app = createApp(deps, '*');

  const raw = (body: string) => app.request('/', { method: 'POST', body });
  const post = async (action: string, payload: Record<string, unknown> = {}): Promise<TestReply> =>
    (await raw(JSON.stringify({ secret: SECRET, action, ...payload }))).json() as Promise<TestReply>;

  return {
    app, db, deps, post, raw, sheet, state, vision, errors, shopId, mirror,
    /** Sends everything waiting to the stand-in Sheet, as the background worker does. */
    drainSheet: () => mirror.drain(),
    /** The changes queued for the Sheet, oldest first. */
    queued: async () => (await db.select().from(sheetOutbox).orderBy(sheetOutbox.id)).map((row) => ({ ...row, payload: row.payload as SheetEvent })),
    product: async (code: string) => (await post('bootstrap')).data.products.find((candidate: { code: string }) => candidate.code === code),
    stockOf: async (code: string) => (await post('stock')).data.rows.find((row: { code: string }) => row.code === code),
  };
}

export type TestServer = Awaited<ReturnType<typeof testServer>>;

export const noDetails = {
  name: '', size: '', barcode: '', category: '', expiry: '', brand: '', variant: '', description: '', batchNumber: '',
  manufactureDate: '', manufacturer: '', countryOfOrigin: '', ingredients: '', directions: '', otherDetails: '', labelText: '', qrCode: '',
};

let nextRequest = 0;
/** A fresh request ID, as a phone makes one for each save. */
export const requestId = () => `test-request-${String(++nextRequest).padStart(6, '0')}`;

export const countRow = (overrides: Record<string, unknown> = {}) => ({
  productCode: 'RG-BLK-500', newProduct: null, fullCartons: 0, packSize: null, loosePieces: 5, confidence: 'High', note: 'Clear single row.', ...overrides,
});
export const saveCounts = (rows: unknown[], overrides: Record<string, unknown> = {}) => ({
  requestId: requestId(), location: 'Shop shelf', counter: 'Ama', rows, ...overrides,
});
export const productSave = (product: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => ({
  requestId: requestId(),
  product: { ...noDetails, code: null, name: 'QBH Glycerin Oil', size: '250ml', category: 'Body oil', packSize: 24, reorderLevel: 10, ...product },
  ...overrides,
});
export const adjustment = (overrides: Record<string, unknown> = {}) => ({
  requestId: requestId(), location: 'Shop shelf', counter: 'Ama', productCode: 'RG-YEL', type: 'correct', quantity: 10, reason: '', ...overrides,
});
