import postgres from 'postgres';
import { openDatabase, runMigrations } from '../src/db/client.ts';
import { requireAppRepository } from './companion.ts';
import { TEST_DATABASE_URL } from './harness.ts';

/** Makes an empty test database with the current tables, once per run. Needs `npm run db:up`. */
export default async function setup(): Promise<void> {
  requireAppRepository();
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);
  if (!/^[a-z_]+_test$/.test(name)) throw new Error(`Refusing to recreate "${name}": the test database's name must end in _test.`);

  url.pathname = '/postgres';
  const admin = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.unsafe(`create database ${name}`);
  } catch (error) {
    throw new Error(`The test database could not be made. Is Postgres running (npm run db:up)?\n${String(error)}`);
  } finally {
    await admin.end();
  }

  const { db, close } = openDatabase(TEST_DATABASE_URL, 1);
  await runMigrations(db);
  await close();
}
