import type { Transaction } from '../db/client.ts';
import { sheetOutbox } from '../db/schema.ts';

/** A product as the Sheet's Products tab holds it. */
export type SheetProduct = Record<string, string | number | null | string[]> & { code: string; name: string };

/** One change to copy to the Google Sheet. apps-script/Code.gs applies each kind (its `mirror` action). */
export type SheetEvent =
  | { kind: 'product'; product: SheetProduct }
  | { kind: 'productDeleted'; code: string; name: string }
  | {
      kind: 'counts'; countDate: string; location: string; counter: string;
      rows: { code: string; fullCartons: number; packSize: number | null; loosePieces: number; confidence: string; note: string }[];
    }
  | {
      kind: 'adjustment'; at: string; counter: string; countDate: string; location: string;
      productName: string; type: string; quantity: number; reason: string;
    }
  | { kind: 'settings'; countDate: string };

/**
 * Where saves leave their changes for the Sheet. `enqueue` is called inside the save's own
 * transaction, so an event exists exactly when its change was saved; `kick` says "there is
 * something to send" and returns at once. The save never waits for Google. `nudge` is called on
 * every request: a chance to send what an earlier attempt could not.
 */
export type SheetMirror = {
  enqueue(tx: Transaction, event: SheetEvent): Promise<void>;
  kick(): void;
  nudge(): void;
};

/** Used when no Sheet is connected: nothing is queued. */
export const noMirror: SheetMirror = { enqueue: async () => {}, kick: () => {}, nudge: () => {} };

export async function enqueueSheetEvent(tx: Transaction, event: SheetEvent): Promise<void> {
  await tx.insert(sheetOutbox).values({ payload: event });
}
