import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The tests check this server against the two things it must agree with, which live in the app's
 * repository (YottademTech/queenscode-stock): the Apps Script it talks to (apps-script/Code.gs,
 * run on its in-memory stand-ins) and the shapes the app expects (web/src/api/contract.ts).
 *
 * The app's repository is looked for at STOCK_APP_DIR, else in the folder above this one, which is
 * where it is when this repository is checked out as server/ inside it.
 */
export const APP_DIR = resolve(process.env.STOCK_APP_DIR ?? fileURLToPath(new URL('../..', import.meta.url)));

export function requireAppRepository(): void {
  if (!existsSync(resolve(APP_DIR, 'apps-script/Code.gs')) || !existsSync(resolve(APP_DIR, 'web/src/api/contract.ts'))) {
    throw new Error(
      `The tests need the app's repository (queenscode-stock), and it is not at ${APP_DIR}.\n`
      + 'Check it out there, or set STOCK_APP_DIR to where it is.',
    );
  }
}

const fromApp = <T>(path: string): Promise<T> => import(pathToFileURL(resolve(APP_DIR, path)).href) as Promise<T>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schema = { parse(value: unknown): any };

/** The app's schemas for what it receives from the server. */
export const appContract = () => fromApp<Record<'bootstrapSchema' | 'stockSchema' | 'countAnalysisSchema' | 'labelReadingSchema', Schema>>('web/src/api/contract.ts');

/** The Apps Script's test stand-ins: the real Code.gs on an in-memory Sheet and Drive. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const appsScriptFakes = () => fromApp<Record<string, any>>('apps-script/test/fakes.mjs');
