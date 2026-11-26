# Stock server

The backend of the QueensCode stock app: Hono, Postgres and Drizzle, in TypeScript. It counts stock
from photos with Claude, keeps products, counts and adjustments in Postgres, and copies every
change to the shop's Google Sheet in the background.

The app that staff use on their phones, and the Apps Script behind the Google Sheet, are in the
app's repository, [YottademTech/queenscode-stock](https://github.com/YottademTech/queenscode-stock).
The two are made to work together: the app talks to this server, and this server talks to the
Apps Script.

this repository is a backend with a real database. The app talks to it exactly as it talks to the Apps
Script (one POST per request, the same actions and replies), so switching is one setting:
`VITE_API_URL`. Nothing in the app changes, and saves waiting on a phone still go through.

What it changes:

- **Postgres is the source of truth.** No limit of 200 products or 500 count rows.
- **Many phones at once.** A save holds no global lock. Counting listed products locks nothing at
  all; adding a product or editing one waits only on that product. On a laptop, 300 saves fired
  in the same instant finished in under a third of a second with every total exact.
- **The Google Sheet becomes a copy.** Each save also leaves a note of what changed, in the same
  transaction. A background worker sends those notes to the Apps Script in order. The save never
  waits for Google; if Google is slow or down, the notes wait and are sent later, once each.
- **Photos stay in Google Drive** for now, stored through the Apps Script. `src/photos/store.ts`
  is the one place to change when they move to blob storage.

## How it is laid out

```
src/
  index.ts        starts everything: settings, database, HTTP, the Sheet worker
  app.ts          the HTTP app (Hono): CORS, size limit, health check
  config.ts       every setting, read from the environment and checked on start
  http/rpc.ts     one request in, one reply out: the secret, the action table, the error format
  db/             schema.ts (the tables), client.ts, writes.ts (save-once and locking)
  shop/           which shop, its places and its open stocktake
  catalog/        products, their details, names and codes, prices
  stocktake/      photo counts, hand entries, the stock figures, what the app loads on opening
  vision/         what Claude is asked and how its answer is checked
  photos/         where product photos are kept
  sheet/          the copy to the Google Sheet (events, worker, gateway) and the first import from it
  scripts/        commands: db:setup, import:sheet, stocktake
drizzle/         SQL migrations, written by "npm run db:generate" from db/schema.ts
test/            tests, run against a real Postgres
```

Three rules hold in the tables (`db/schema.ts`): counts and hand entries are a ledger that is only
added to, and stock is always worked out from it; every row belongs to a shop; money is whole
minor units (pesewas) beside a currency code. The Postgres image already carries pgvector, so
vector search later starts with `CREATE EXTENSION vector`.

## Run it locally

```
npm install
npm run db:up        # Postgres in Docker, on port 54329
npm run db:setup     # tables, the shop, currencies, places, a stocktake dated today
npm run dev          # the server, on http://localhost:8791
```

Copy `.env.example` to `.env` first: it holds `DATABASE_URL` for that local Postgres. Then run the
app (in the app's repository) against the server: `cd web && VITE_API_URL=http://localhost:8791 npm run dev`.

To try the Sheet copy without Google, set `SHEET_GATEWAY_URL=http://localhost:8790` and a
`SHEET_GATEWAY_SECRET` of your own in `.env`, and run `npm run backend` in the app's `web/` as
well: the stand-in reads the same secret from the app's `.env`.

The server has two ways in. `src/serve.ts` is a process that stays running (what `npm run dev`
and the `Dockerfile` use). `src/index.ts` only hands the app over, for a host such as Vercel that
runs it one request at a time.

## The two secrets

The Apps Script now checks two secrets, both in its Script Properties:

| Script Property | Who holds it | What it opens |
|---|---|---|
| `APP_SECRET` | every phone, inside the app | the app's actions: counting, products, adjustments |
| `SERVER_SECRET` | only the stock server (`SHEET_GATEWAY_SECRET`) | the server's actions: copying changes into the Sheet, storing and trashing photos, reading the whole Sheet out |

The server's actions can write anything into the Sheet, so the secret inside the app does not
open them. Until `SERVER_SECRET` is set they are switched off, and the script refuses a
`SERVER_SECRET` equal to `APP_SECRET`. Use a long random value.

## Deploying the server on Vercel, from the git repository

The app is deployed from its own repository; this one becomes a second Vercel project.

1. **Create the project.** In Vercel: Add New > Project, and import this repository. Leave Root
   Directory as it is. Vercel recognises a Hono app from `src/index.ts`. Let the first deployment
   fail if it starts: it has no database yet.
2. **Add a database.** In the project: Storage (or the Marketplace) > Postgres > Neon. Choose the
   **Frankfurt** region, the one `vercel.json` runs the server in, and connect it to the
   project. It adds the connection settings: check under Settings > Environment Variables that
   there is a `DATABASE_URL` (the pooled address, with `-pooler` in the host name) and a
   `DATABASE_URL_UNPOOLED` (the direct one). If your provider names them differently, add those
   two names yourself with the same values.
3. **Add the settings** under Settings > Environment Variables, for Production:

   | Name | Value |
   |---|---|
   | `APP_SECRET` | the app's secret, the same as `VITE_APP_SECRET` |
   | `CLAUDE_API_KEY` | the Claude API key |
   | `ALLOWED_ORIGINS` | the app's address, such as `https://queenscode-stock.vercel.app` |

4. **Deploy** (Deployments > Redeploy, or push again). The build runs `npm run vercel-build`,
   which creates the tables and the shop; its log ends with "The database is ready". Then open
   the server's address: it shows `{"ok":true,"data":{"service":"stock-count"}}`, and `/health`
   shows `{"ok":true}` when the database answers.
5. **Update the Apps Script.** Paste `apps-script/Code.gs` from the app's repository, then Deploy > Manage deployments >
   Edit > New version > Deploy. In Project Settings > Script Properties add `SERVER_SECRET`, a new
   random value of 16 or more characters. The app keeps working throughout.
6. **Connect the server to it.** Add two more settings to the server project and redeploy:
   `SHEET_GATEWAY_URL`, the Apps Script web app URL ending in `/exec`, and
   `SHEET_GATEWAY_SECRET`, the `SERVER_SECRET` from step 5.
7. **Fill the database from the Sheet**, from this computer, with the hosted database's direct
   address (copy it from Vercel):

   ```
   DATABASE_URL="postgres://..." SHEET_GATEWAY_URL="https://script.google.com/macros/s/.../exec" \
     SHEET_GATEWAY_SECRET="..." npm run import:sheet
   ```

   It brings over the places, currencies, products, every count and hand entry, and the saves
   already written, and lists every Sheet row it had to leave out, with the reason.
8. **Point the app at the server.** In the app's Vercel project set `VITE_API_URL` to the
   server's address and redeploy it. From then on the Sheet is filled by the server.
9. **Close the old way in.** Change `APP_SECRET` in the Apps Script's Script Properties to a new
   random value that nothing uses. The app no longer talks to the Apps Script, and this stops
    anyone holding the app from writing to the Sheet directly.

Do steps 7 and 8 together, while nobody is counting: a count saved to the Sheet between them is
not in the database.

A host that runs a container works too (`Dockerfile`, health check `GET /health`), with
the same settings. There the server stays running and has no size limit on requests.

## What is different on Vercel

- **One request may carry at most 4.5 MB**, and photos travel inside the request. The server
  tells the app how much it takes (`requestLimit`), and the app makes a video's views smaller,
  and sends fewer of them if the detail photos leave no room. Vercel can raise the limit to
  20 MB on its paid plans (`VERCEL_SUPPORT_LARGE_REQUEST_BODY`); then set `REQUEST_LIMIT_BYTES`
  to match.
- **Nothing runs between requests.** Changes for the Sheet are sent straight after each save,
  while Vercel is asked to wait. What could not be sent then (Google was down) goes with the next
  request of any kind, such as someone opening the app. If nobody uses the app, nothing is sent.
- **The database address must be the pooled one** at run time; the commands that change tables
  use the direct one. The server keeps at most five connections per running copy
  (`DATABASE_POOL_SIZE`).
- **Only production deployments change the tables.** A preview build of a branch skips the
  database set-up, because it shares the database with the live server.
- **To start a new stocktake**, run the command from this computer against the hosted database:
  `DATABASE_URL="postgres://..." npm run stocktake -- 2026-12-01`.
- This has been checked by loading the server the way Vercel does, not by a deployment. If the
  first build fails, its log says why.

## Things to know

- **A new stocktake** is started on the server, not in the Sheet: `npm run stocktake -- 2026-12-01`.
  The Sheet's count date follows by itself.
- **Places and currencies** come from the Sheet at import. To change them afterwards, change the
  `locations` and `currencies` tables; the Sheet's own lists must name the same places, or it
  refuses counts for the ones it does not know.
- **When the Sheet cannot take a change.** It still holds only 200 products and 500 count rows.
  - *Count rows full:* the counts wait, with every later change behind them, and the server's log
    says so each time it tries. Clear old rows from Claude_Counts and they arrive, in order.
  - *Products full, or a change the Sheet will never accept:* that one change is set aside
    (`failed_at` and `last_error` in the `sheet_outbox` table) and the later ones go on.

  The database has every change regardless. Do not edit the Sheet by hand any more, apart from
  clearing old count rows: the server does not read it back.
- **Starting over from the Sheet** (`npm run import:sheet -- --replace`) discards what the
  database holds, and drops any change still waiting to be copied to the Sheet.
- **Deleting a product** hides it and what was counted for it. The rows are kept in the database.
- **Product codes** that Google Sheets would read as a date or a number (`SEP-30`, `12-5`) get a
  `P-` in front when they are made.
- **Sign-in is unchanged:** the shared secret and the code on the phone. Accounts per staff member
  are the next step, and the server is where they will live.

## Tests

```
npm run db:up          # the local Postgres the tests use
npm test               # the server, on a real database, with the real Code.gs standing in for Google
npm run typecheck
```

The tests check this server against the app's repository: the Apps Script it talks to
(`apps-script/Code.gs`, run on in-memory stand-ins for the Sheet and Drive) and the shapes the app
expects (`web/src/api/contract.ts`). They look for that repository in the folder above this one,
which is where it is when this repository is checked out as `server/` inside it, or at
`STOCK_APP_DIR`.

The wording Claude is given (`src/vision/prompts.ts`) and the rules for product names and codes
(`src/catalog/names.ts`) are also in `Code.gs`; a test fails when the two copies differ.
