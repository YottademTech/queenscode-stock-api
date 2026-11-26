// The server as a process that stays running: on a computer ("npm run dev") or in a container.
import { serve } from '@hono/node-server';
import { loadConfigOrExit } from './config.ts';
import { openDatabase, runMigrations } from './db/client.ts';
import { createRuntime } from './runtime.ts';

const config = loadConfigOrExit();

// The tables are brought up to date before anything is served, over the direct connection.
const migrator = openDatabase(config.DATABASE_URL_UNPOOLED || config.DATABASE_URL, 2);
await runMigrations(migrator.db);
await migrator.close();

const { app, mirror, close } = createRuntime(config);
const stopPolling = mirror?.poll();

const server = serve({ fetch: app.fetch, port: config.PORT }, (address) => {
  console.log(`Stock server on http://localhost:${address.port}`);
  console.log(mirror ? 'Google Sheet: changes are copied in the background.' : 'Google Sheet: not connected (SHEET_GATEWAY_URL is empty).');
  console.log(config.CLAUDE_API_KEY ? `Claude: ${config.CLAUDE_MODEL}` : 'Claude: no CLAUDE_API_KEY, photos cannot be read.');
  // Anything left from before a restart is sent now.
  mirror?.nudge();
});

// On a stop signal: finish the requests in hand, then let go of the database.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopPolling?.();
    server.close(() => void close().finally(() => process.exit(0)));
  });
}
