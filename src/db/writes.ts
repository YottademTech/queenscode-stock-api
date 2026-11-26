import { sql } from 'drizzle-orm';
import { requestIdOf } from '../lib/validate.ts';
import type { Database, Transaction } from './client.ts';
import { handledRequests } from './schema.ts';

export type SaveResult = { duplicate: boolean };

/**
 * Runs a save as one transaction that happens exactly once per request ID.
 *
 * The ID is claimed first. A second arrival of the same save, even at the same instant, waits on
 * that claim and then finds it taken: it writes nothing and is told `duplicate`. If the write
 * fails, the claim is undone with it, so the phone can send the save again.
 */
export async function writeOnce(
  db: Database,
  request: Record<string, unknown>,
  write: (tx: Transaction) => Promise<void>,
): Promise<SaveResult> {
  const requestId = requestIdOf(request);
  return db.transaction(async (tx) => {
    const claimed = await tx.insert(handledRequests)
      .values({ requestId, action: String(request.action) })
      .onConflictDoNothing()
      .returning({ requestId: handledRequests.requestId });
    if (claimed.length === 0) return { duplicate: true };

    await write(tx);
    return { duplicate: false };
  });
}

export async function wasHandled(db: Database, requestId: string): Promise<boolean> {
  const rows = await db.select({ requestId: handledRequests.requestId }).from(handledRequests)
    .where(sql`${handledRequests.requestId} = ${requestId}`).limit(1);
  return rows.length > 0;
}

/**
 * Makes saves that add products to a shop take turns, until the transaction ends. Adding a product
 * means choosing a code and checking the name is free, which two saves must not do at once.
 * Saves that only count listed products never wait here.
 */
export async function lockCatalog(tx: Transaction, shopId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'catalog:' + shopId}, 0))`);
}
