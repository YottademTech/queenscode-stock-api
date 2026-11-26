import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema.ts';

export type Database = ReturnType<typeof openDatabase>['db'];
/** A database, or a transaction on one: what every query function takes. */
export type Queryable = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** True on a host that only runs the server while a request is being answered. */
const SERVERLESS = Boolean(process.env.VERCEL);

export function openDatabase(url: string, poolSize: number) {
  const client = postgres(url, {
    max: poolSize,
    // A hosted Postgres is reached through a connection pooler, which hands each transaction to
    // whichever connection is free. Statements prepared on one would be unknown on the next.
    prepare: false,
    // Such a host can freeze the server between requests: connections are let go soon after use,
    // so none is left open by a server that is not running.
    idle_timeout: SERVERLESS ? 5 : 0,
    connect_timeout: 15,
    // Notices (such as "relation already exists, skipping") are not worth a log line.
    onnotice: () => {},
  });
  return { db: drizzle(client, { schema }), close: () => client.end({ timeout: 5 }) };
}

/** Brings the tables up to date. Safe to run on every start: applied migrations are skipped. */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
}

/** SQLSTATE of a failure raised by Postgres, wherever the driver or Drizzle wrapped it. */
export function postgresErrorCode(error: unknown): string | null {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}
