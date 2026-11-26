// The server as a host such as Vercel runs it: the app is handed over, and the host calls it for
// each request. Nothing listens here and nothing runs between requests; changes for the Google
// Sheet are sent after each request, while the host is asked to wait (see sheet/worker.ts).
// The database tables are brought up to date when the server is built ("npm run vercel-build").
//
// Vercel takes this file as the server because of its name and because it imports Hono itself.
//
// To run the server yourself, on a computer or in a container, use serve.ts ("npm run dev").
import { Hono } from 'hono';
import { loadConfigOrExit } from './config.ts';
import { createRuntime } from './runtime.ts';

const app = new Hono();
app.route('/', createRuntime(loadConfigOrExit()).app);

export default app;
