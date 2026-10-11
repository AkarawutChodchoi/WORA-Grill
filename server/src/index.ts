import { buildApp } from './app';
import { loadConfig } from './config';
import { openDatabase } from './db/client';
import { EventBus } from './lib/events';

const config = loadConfig();
const database = await openDatabase({ url: config.DATABASE_URL, dataDir: config.PGLITE_DIR });
await database.migrate();
const app = await buildApp({ db: database.db, bus: new EventBus(), config }, { logger: true });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await database.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info(`database: ${database.kind}`);
