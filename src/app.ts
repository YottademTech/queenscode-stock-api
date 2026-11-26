import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { Deps } from './deps.ts';
import { handleRequest, statusOf, type Reply } from './http/rpc.ts';

export function createApp(deps: Deps, allowedOrigins: string) {
  const app = new Hono();
  const origins = allowedOrigins.split(',').map((origin) => origin.trim()).filter(Boolean);
  app.use(cors({ origin: origins.includes('*') ? '*' : origins, allowMethods: ['GET', 'POST'], maxAge: 86_400 }));

  /** Lets the owner confirm the address in a browser without the secret. */
  app.get('/', (context) => context.json({ ok: true, data: { service: 'stock-count' } }));

  /** For the host's health check: answers 200 only when the database answers. */
  app.get('/health', async (context) => {
    try {
      await deps.db.execute(sql`select 1`);
      return context.json({ ok: true });
    } catch {
      return context.json({ ok: false }, 503);
    }
  });

  const tooLarge: Reply = { ok: false, error: { code: 'invalid_request', message: 'The request was too large. Use fewer or smaller photos.' } };
  app.post('/', bodyLimit({ maxSize: deps.config.REQUEST_LIMIT_BYTES, onError: (context) => context.json(tooLarge, 413) }), async (context) => {
    // Read as text whatever the content type: the app sends JSON as text/plain.
    const reply = await handleRequest(deps, await context.req.text());
    return context.json(reply, statusOf(reply));
  });

  return app;
}
