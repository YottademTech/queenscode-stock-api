import type { Config } from './config.ts';
import type { Database } from './db/client.ts';
import type { PhotoStore } from './photos/store.ts';
import type { SheetMirror } from './sheet/events.ts';
import type { VisionModel } from './vision/model.ts';

export type Logger = { info(message: string): void; error(message: string, error?: unknown): void };

/** Everything a request handler reaches outside itself. Tests pass stand-ins for the last four. */
export type Deps = {
  db: Database;
  config: Pick<Config, 'APP_SECRET' | 'SHOP_SLUG' | 'CLAUDE_DAILY_CALL_LIMIT' | 'REQUEST_LIMIT_BYTES'>;
  vision: VisionModel;
  photos: PhotoStore;
  mirror: SheetMirror;
  log: Logger;
};

export const consoleLog: Logger = {
  info: (message) => console.log(message),
  // Request bodies are never passed here: they hold the app secret and photos.
  error: (message, error) => console.error(message, error instanceof Error ? error.stack ?? error.message : error ?? ''),
};
