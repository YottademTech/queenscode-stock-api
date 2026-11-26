import { createApp } from './http/app.ts';
import type { Config } from './config.ts';
import { openDatabase } from './db/client.ts';
import { consoleLog, type Deps } from './deps.ts';
import { drivePhotoStore } from './photos/store.ts';
import { noMirror } from './sheet/events.ts';
import { sheetGateway } from './sheet/gateway.ts';
import { startSheetMirror } from './sheet/worker.ts';
import { claudeVision } from './vision/model.ts';

/**
 * Puts the server together from its settings: the database, Claude, Google, and the HTTP app over
 * them. Nothing here listens on a port or keeps time: serve.ts does that for a server that stays
 * running, and index.ts hands the app to a host that runs it one request at a time.
 */
export function createRuntime(config: Config) {
  const { db, close } = openDatabase(config.DATABASE_URL, config.DATABASE_POOL_SIZE);
  const gateway = config.SHEET_GATEWAY_URL === '' ? null : sheetGateway(config.SHEET_GATEWAY_URL, config.SHEET_GATEWAY_SECRET);
  const mirror = gateway ? startSheetMirror(db, gateway, consoleLog) : null;

  const deps: Deps = {
    db,
    config,
    vision: claudeVision(config.CLAUDE_API_KEY, config.CLAUDE_MODEL),
    photos: drivePhotoStore(gateway),
    mirror: mirror ?? noMirror,
    log: consoleLog,
  };

  return { app: createApp(deps, config.ALLOWED_ORIGINS), db, mirror, close };
}
