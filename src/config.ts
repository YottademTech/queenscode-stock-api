import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** A setting the server cannot start without. `hint` says what to set, for the person reading the error. */
const required = (hint: string, minLength = 1) => z.string({ error: hint }).min(minLength, hint);

const configSchema = z.object({
  /**
   * A direct connection to the same database, for the commands that change its tables. A hosted
   * Postgres gives two addresses: a pooled one for the server and this one. Empty means DATABASE_URL.
   */
  DATABASE_URL_UNPOOLED: z.string().default(''),
  /** postgres://user:password@host:port/database */
  DATABASE_URL: required('is not set. For the local database (npm run db:up), add this line to .env: DATABASE_URL=postgres://stock:stock@127.0.0.1:54329/stock'),
  /** The password the app sends with every request. */
  APP_SECRET: required('is not set, or is shorter than 16 characters. It is the app\'s password: VITE_APP_SECRET in .env serves for both.', 16),
  PORT: z.coerce.number().int().min(1).max(65535).default(8791),
  /** Web origins allowed to call this server, separated by commas. `*` allows any. */
  ALLOWED_ORIGINS: z.string().default('*'),
  /** How many database connections this process may hold. Kept small on Vercel, where each running copy has its own. */
  DATABASE_POOL_SIZE: z.coerce.number().int().min(2).max(100).optional(),
  /**
   * The largest request body accepted, in bytes. Photos travel inside the request, so this is what
   * bounds them. Where the host has its own limit (Vercel refuses anything over 4.5 MB before it
   * reaches the server) this must be below it; the app is told, and sizes what it sends to fit.
   */
  REQUEST_LIMIT_BYTES: z.coerce.number().int().min(1_000_000).max(50_000_000).optional(),

  CLAUDE_API_KEY: z.string().default(''),
  CLAUDE_MODEL: z.string().default('claude-haiku-5-5'),
  /** Stops a leaked app secret from draining API credits. A full stocktake is a few hundred photos. */
  CLAUDE_DAILY_CALL_LIMIT: z.coerce.number().int().min(1).default(1500),

  /**
   * The Apps Script web app (URL ending in /exec). It keeps the Google Sheet up to date and stores
   * product photos in Google Drive. Left empty, nothing is sent to Google and photos cannot be saved.
   */
  SHEET_GATEWAY_URL: z.string().default(''),
  /**
   * SERVER_SECRET in the Apps Script's Script Properties: the key to the actions only this server
   * may call. It is not the app's secret, which every phone holds.
   */
  SHEET_GATEWAY_SECRET: z.string().default(''),

  /** Which shop this server serves. One for now; every row already says which shop it belongs to. */
  SHOP_SLUG: z.string().min(1).default('main'),
  SHOP_NAME: z.string().min(1).default('QueensCode Beauty Haven'),
  /** Decides what "today" is for the shop. */
  SHOP_TIME_ZONE: z.string().min(1).default('Africa/Accra'),
});

export type Config = z.infer<typeof configSchema> & { REQUEST_LIMIT_BYTES: number; DATABASE_POOL_SIZE: number };

/**
 * Reads the settings from the environment, after loading the project's .env when there is one.
 * In production the host sets them and there is no file.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) {
    try {
      // This repository's own .env, else the one of the app's repository when this is checked out inside it.
      const own = fileURLToPath(new URL('../.env', import.meta.url));
      process.loadEnvFile(existsSync(own) ? own : fileURLToPath(new URL('../../.env', import.meta.url)));
    } catch {
      // No .env file: every setting comes from the environment itself.
    }
  }
  const parsed = configSchema.safeParse({
    ...env,
    // One .env serves the app and this server: the app's copy of the secret is the same secret.
    APP_SECRET: env.APP_SECRET || env.VITE_APP_SECRET,
  });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('\n  ');
    throw new Error(`The server is not configured:\n  ${problems}`);
  }
  // On Vercel the platform's own 4.5 MB limit decides; elsewhere there is room for a full set of photos.
  const config = {
    ...parsed.data,
    REQUEST_LIMIT_BYTES: parsed.data.REQUEST_LIMIT_BYTES ?? (env.VERCEL ? 4_400_000 : 24 * 1024 * 1024),
    DATABASE_POOL_SIZE: parsed.data.DATABASE_POOL_SIZE ?? (env.VERCEL ? 5 : 10),
  };
  if (config.SHEET_GATEWAY_URL !== '' && (config.SHEET_GATEWAY_SECRET.length < 16 || config.SHEET_GATEWAY_SECRET === config.APP_SECRET)) {
    throw new Error('The server is not configured:\n  SHEET_GATEWAY_SECRET must be 16+ characters and different from the app\'s secret. Use the same value as SERVER_SECRET in the Apps Script\'s Script Properties.');
  }
  return config;
}

/** For the entry points: says what is missing in plain words, without a stack trace, and stops. */
export function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
