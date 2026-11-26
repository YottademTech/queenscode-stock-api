import { expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';

const needed = { DATABASE_URL: 'postgres://user:pass@db.example/stock', APP_SECRET: 'an-app-secret-0123456789' };

test('the settings fit the host: a server that stays running has room, Vercel has its limits', () => {
  expect(loadConfig({ ...needed })).toMatchObject({ REQUEST_LIMIT_BYTES: 24 * 1024 * 1024, DATABASE_POOL_SIZE: 10, PORT: 8791, CLAUDE_MODEL: 'claude-haiku-5-5' });
  // Vercel refuses any request over 4.5 MB before it reaches the server, and runs many copies.
  expect(loadConfig({ ...needed, VERCEL: '1' })).toMatchObject({ REQUEST_LIMIT_BYTES: 4_400_000, DATABASE_POOL_SIZE: 5 });
  expect(loadConfig({ ...needed, VERCEL: '1', REQUEST_LIMIT_BYTES: '20000000', DATABASE_POOL_SIZE: '3' })).toMatchObject({ REQUEST_LIMIT_BYTES: 20_000_000, DATABASE_POOL_SIZE: 3 });
});

test('a missing or unsafe setting is named in plain words', () => {
  expect(() => loadConfig({})).toThrow(/DATABASE_URL is not set[\s\S]*APP_SECRET is not set/);
  expect(() => loadConfig({ ...needed, APP_SECRET: 'short' })).toThrow(/APP_SECRET is not set, or is shorter than 16 characters/);
  // The app's own copy of the secret serves when APP_SECRET is not given.
  expect(loadConfig({ DATABASE_URL: needed.DATABASE_URL, VITE_APP_SECRET: needed.APP_SECRET }).APP_SECRET).toBe(needed.APP_SECRET);

  // The key to the Apps Script's server-only actions must exist and must not be the app's secret.
  const withGoogle = { ...needed, SHEET_GATEWAY_URL: 'https://script.google.com/macros/s/x/exec' };
  expect(() => loadConfig(withGoogle)).toThrow(/SHEET_GATEWAY_SECRET must be 16\+ characters and different from the app's secret/);
  expect(() => loadConfig({ ...withGoogle, SHEET_GATEWAY_SECRET: needed.APP_SECRET })).toThrow(/SHEET_GATEWAY_SECRET/);
  expect(loadConfig({ ...withGoogle, SHEET_GATEWAY_SECRET: 'a-server-secret-0123456789' }).SHEET_GATEWAY_SECRET).toBe('a-server-secret-0123456789');
});
