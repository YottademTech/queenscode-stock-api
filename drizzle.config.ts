import { defineConfig } from 'drizzle-kit';

// Only used to write SQL migrations from src/db/schema.ts (npm run db:generate). The server
// applies them itself on start, so this never needs the database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
