import { waitUntil } from '@vercel/functions';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { sheetOutbox } from '../db/schema.ts';
import type { Logger } from '../deps.ts';
import { isRecord } from '../lib/text.ts';
import { enqueueSheetEvent, type SheetMirror } from './events.ts';
import { GatewayUnreachable, type GatewayReply, type SheetGateway } from './gateway.ts';

const MIRROR_TIMEOUT_MS = 60_000;
const POLL_MS = 30_000;
/** How soon a change that could not be sent is looked at again, when nothing says exactly. */
const LOOK_AGAIN_MS = 15_000;
const FIRST_RETRY_MS = 5_000;
const LONGEST_RETRY_MS = 10 * 60_000;
/**
 * Whether the Sheet's answer means it will never take this change, so it is set aside and the
 * changes after it go on. Anything else is tried again later, with everything behind it waiting.
 *
 * A full count tab is not for good: the owner clears old rows and the counts then arrive, in
 * order. A full product tab is: nothing frees a row except a delete, and that would wait behind it.
 */
function refusedForGood(code: string, event: unknown): boolean {
  if (code === 'invalid_request') return true;
  return code === 'sheet_full' && !(isRecord(event) && event.kind === 'counts');
}

type Step = 'delivered' | 'refused' | 'retry' | 'idle' | 'waiting' | 'elsewhere' | 'not-ready';

/**
 * Copies saved changes to the Google Sheet, in the background.
 *
 * Saves put their changes in the sheet_outbox table inside their own transaction and return. This
 * worker sends them to the Apps Script one at a time, oldest first, so the Sheet sees a product
 * before the counts for it. Nothing is lost when Google is slow or down: an event stays in the
 * table and is sent again later, and the Sheet writes one that arrives twice only once.
 *
 * It has no clock of its own. On a host that keeps the server running, poll() gives it one. On a
 * host that only runs the server while a request is being answered (Vercel), every request nudges
 * it, and the host is asked to stay awake until what is waiting has been sent.
 */
export function startSheetMirror(db: Database, gateway: SheetGateway, log: Logger): SheetMirror & { drain(): Promise<void>; settled(): Promise<void>; poll(): () => void } {
  let draining: Promise<void> | null = null;
  let kickedWhileDraining = false;
  let ready = false;
  // Nothing is known at the start: there may be changes left from before a restart.
  let nothingWaiting = false;
  let lookAgainAt = 0;

  /** One event, inside one transaction that holds the queue's lock, so two servers never send at once. */
  async function deliverNext(): Promise<Step> {
    if (!ready) {
      // An Apps Script from before this server would refuse every event as an unknown action, and
      // each would be marked refused for good. Wait until the new version is deployed and holds
      // this server's secret.
      let reply: GatewayReply;
      try {
        reply = await gateway.call('serverInfo', {}, MIRROR_TIMEOUT_MS);
      } catch (error) {
        if (!(error instanceof GatewayUnreachable)) throw error;
        log.error(`${error.message} Changes for the Sheet are kept and sent later.`);
        return 'not-ready';
      }
      ready = reply.ok && isRecord(reply.data) && Array.isArray(reply.data.actions) && reply.data.actions.includes('mirror');
      if (!ready) {
        log.error(reply.ok
          ? 'The Apps Script cannot take changes from this server yet. Paste the current Code.gs and deploy a new version.'
          : `The Apps Script does not accept this server yet (${reply.error.code}: ${reply.error.message}). It needs the current Code.gs deployed as a new version, and SERVER_SECRET in its Script Properties equal to this server's SHEET_GATEWAY_SECRET. Changes for the Sheet are kept and sent later.`);
        return 'not-ready';
      }
    }

    return db.transaction(async (tx): Promise<Step> => {
      const [lock] = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended('sheet-mirror', 0)) as locked`) as unknown as { locked: boolean }[];
      if (!lock?.locked) return 'elsewhere';

      const [event] = await tx.select().from(sheetOutbox)
        .where(and(isNull(sheetOutbox.deliveredAt), isNull(sheetOutbox.failedAt)))
        .orderBy(asc(sheetOutbox.id)).limit(1);
      if (!event) return 'idle';
      // The oldest event is not due yet. Later ones wait behind it, to keep the order.
      if (event.nextAttemptAt.getTime() > Date.now()) {
        lookAgainAt = event.nextAttemptAt.getTime();
        return 'waiting';
      }

      let problem: string;
      try {
        const reply = await gateway.call('mirror', { requestId: event.eventId, event: event.payload }, MIRROR_TIMEOUT_MS);
        if (reply.ok) {
          await tx.update(sheetOutbox).set({ deliveredAt: sql`now()`, attempts: event.attempts + 1, lastError: null }).where(eq(sheetOutbox.id, event.id));
          return 'delivered';
        }
        problem = `${reply.error.code}: ${reply.error.message}`;
        if (refusedForGood(reply.error.code, event.payload)) {
          log.error(`The Sheet refused change ${event.id} and will not get it (${problem}). The database has it.`);
          await tx.update(sheetOutbox).set({ failedAt: sql`now()`, attempts: event.attempts + 1, lastError: problem }).where(eq(sheetOutbox.id, event.id));
          return 'refused';
        }
      } catch (error) {
        if (!(error instanceof GatewayUnreachable)) throw error;
        problem = error.message;
      }

      // Said every time, so the owner hears why the Sheet has stopped following.
      log.error(`Change ${event.id} has not reached the Sheet (${problem}). It is kept and tried again; later changes wait behind it.`);
      const wait = Math.min(FIRST_RETRY_MS * 2 ** event.attempts, LONGEST_RETRY_MS);
      lookAgainAt = Date.now() + wait;
      await tx.update(sheetOutbox)
        .set({ attempts: event.attempts + 1, lastError: problem, nextAttemptAt: new Date(Date.now() + wait) })
        .where(eq(sheetOutbox.id, event.id));
      return 'retry';
    });
  }

  async function drainOnce(): Promise<void> {
    for (;;) {
      const step = await deliverNext();
      if (step === 'delivered' || step === 'refused') continue;
      nothingWaiting = step === 'idle';
      // Not ready, or another server is sending: look again in a while, not on every request.
      if (step === 'not-ready' || step === 'elsewhere') lookAgainAt = Date.now() + LOOK_AGAIN_MS;
      return;
    }
  }

  function drain(): Promise<void> {
    draining ??= drainOnce()
      .catch((error: unknown) => log.error('Copying changes to the Sheet failed; it is tried again shortly.', error))
      .finally(() => {
        draining = null;
        if (kickedWhileDraining) {
          kickedWhileDraining = false;
          kick();
        }
      });
    return draining;
  }

  /** A change was just saved: send it now. */
  function kick(): void {
    nothingWaiting = false;
    lookAgainAt = 0;
    if (draining) kickedWhileDraining = true;
    // Where the host stops the server once the reply is out, this asks it to wait for the sending.
    else waitUntil(drain());
  }

  /** A moment to send what is left over, if anything is and its time has come. Costs nothing otherwise. */
  function nudge(): void {
    if (nothingWaiting || draining || Date.now() < lookAgainAt) return;
    waitUntil(drain());
  }

  /** Nudges on a timer, for a server that keeps running. Returns how to stop it. */
  function poll(): () => void {
    const timer = setInterval(nudge, POLL_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** Resolves once the sending now under way, if any, has finished. It starts none. */
  const settled = (): Promise<void> => draining ?? Promise.resolve();

  return { enqueue: enqueueSheetEvent, kick, nudge, drain, settled, poll };
}
