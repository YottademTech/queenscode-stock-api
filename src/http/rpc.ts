import { createHash, timingSafeEqual } from 'node:crypto';
import { deleteProduct, saveProduct, setProductPrice } from '../catalog/products.ts';
import { postgresErrorCode } from '../db/client.ts';
import type { Deps } from '../deps.ts';
import { AppError, type AppErrorCode } from '../errors.ts';
import { isRecord } from '../lib/text.ts';
import { loadShop, type ShopContext } from '../shop/context.ts';
import { saveAdjustment } from '../stocktake/adjustments.ts';
import { bootstrap } from '../stocktake/bootstrap.ts';
import { saveCounts } from '../stocktake/counts.ts';
import { readStock } from '../stocktake/stock.ts';
import { analyzeCount, readProductLabel } from '../vision/reader.ts';

// The app talks to this server the way it talked to the Apps Script: one POST per request, a JSON
// body naming an `action`, and a reply of { ok: true, data } or { ok: false, error }. Keeping
// that form means the app, and saves still waiting on phones, work against either backend.

type Handler = (deps: Deps, shop: ShopContext, request: Record<string, unknown>) => Promise<unknown>;

/** `writes` actions change data; after one, the Sheet worker is told there is something to send. */
const ACTIONS: Record<string, { run: Handler; writes: boolean }> = {
  bootstrap: { run: (deps, shop) => bootstrap(deps, shop, Object.keys(ACTIONS)), writes: false },
  stock: { run: (deps, shop) => readStock(deps.db, shop), writes: false },
  analyzeCount: { run: analyzeCount, writes: false },
  readProductLabel: { run: readProductLabel, writes: false },
  saveCounts: { run: saveCounts, writes: true },
  saveProduct: { run: saveProduct, writes: true },
  deleteProduct: { run: deleteProduct, writes: true },
  setPrice: { run: setProductPrice, writes: true },
  adjust: { run: saveAdjustment, writes: true },
};

export type Reply = { ok: true; data: unknown } | { ok: false; error: { code: AppErrorCode; message: string } };

export async function handleRequest(deps: Deps, rawBody: string): Promise<Reply> {
  let actionName = 'unknown';
  try {
    const request = parseBody(rawBody);
    authorize(request.secret, deps.config.APP_SECRET);
    actionName = String(request.action);

    const action = Object.hasOwn(ACTIONS, actionName) ? ACTIONS[actionName] : undefined;
    if (!action) throw new AppError('invalid_request', 'Unknown action.');

    const shop = await loadShop(deps.db, deps.config.SHOP_SLUG);
    const data = await action.run(deps, shop, request);
    // A save has something new for the Sheet; any other request is a moment to send what is left over.
    if (action.writes) deps.mirror.kick();
    else deps.mirror.nudge();
    return { ok: true, data };
  } catch (error) {
    const known = error instanceof AppError ? error : databaseBusy(error);
    if (known) return { ok: false, error: { code: known.code, message: known.message } };
    // The request body is never logged: it holds the app secret and photos.
    deps.log.error(`Unexpected failure in "${actionName}".`, error);
    return { ok: false, error: { code: 'internal', message: 'Something went wrong on the server. Try again.' } };
  }
}

/** The HTTP status that goes with each reply. The app reads the body; the status is for logs and tools. */
export function statusOf(reply: Reply): 200 | 400 | 401 | 409 | 429 | 500 | 503 {
  if (reply.ok) return 200;
  const statuses: Record<AppErrorCode, 400 | 401 | 409 | 429 | 500 | 503> = {
    unauthorized: 401, invalid_request: 400, conflict: 409, limit_reached: 429,
    busy: 503, claude_unavailable: 503, claude_declined: 400, not_configured: 500, internal: 500,
  };
  return statuses[reply.error.code];
}

function parseBody(rawBody: string): Record<string, unknown> {
  if (rawBody === '') throw new AppError('invalid_request', 'The request was empty.');
  let request: unknown;
  try {
    request = JSON.parse(rawBody);
  } catch {
    throw new AppError('invalid_request', 'The request was not valid JSON.');
  }
  if (!isRecord(request)) throw new AppError('invalid_request', 'The request was not valid JSON.');
  return request;
}

/** Compares digests so the time taken does not reveal how much of the secret matched. */
function authorize(secret: unknown, expected: string): void {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (typeof secret !== 'string' || !timingSafeEqual(digest(secret), digest(expected))) {
    throw new AppError('unauthorized', 'Wrong or missing app secret.');
  }
}

/**
 * Two saves that collide in the database (a deadlock, or both adding the same product in the same
 * instant) are not errors in the request: sent again, the save goes through. The app does that by
 * itself for `busy`.
 */
function databaseBusy(error: unknown): AppError | null {
  const transient = ['40001', '40P01', '23505', '55P03', '57014'];
  return transient.includes(postgresErrorCode(error) ?? '') ? new AppError('busy', 'The server is busy. Try again in a moment.') : null;
}
