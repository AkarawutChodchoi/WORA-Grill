import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './server/src/db/schema/index.ts',
  out: './server/drizzle',
});
