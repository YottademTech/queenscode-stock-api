// The server as a host such as Vercel runs it: the app is handed over, and the host calls it for
// each request. Nothing listens here and nothing runs between requests; changes for the Google
// Sheet are sent after each request, while the host is asked to wait (see sheet/worker.ts).
// The database tables are brought up to date when the server is built ("npm run vercel-build").
//
// To run the server yourself, on a computer or in a container, use serve.ts ("npm run dev").
import { loadConfigOrExit } from './config.ts';
import { createRuntime } from './runtime.ts';

export default createRuntime(loadConfigOrExit()).app;
