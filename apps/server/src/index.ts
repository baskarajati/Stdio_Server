/**
 * The process entrypoint. Reads the connection string from the environment,
 * builds the pool, starts the Hono server on `PORT` (default 3001).
 */

import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createApp } from './app';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://stdio:stdio@localhost:5432/stdio_dev';
const port = Number(process.env.PORT ?? 3001);

const pool = new Pool({ connectionString, max: 10 });

const app = createApp(pool);

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`stdio server listening on http://localhost:${info.port}`);
});

async function shutdown(): Promise<void> {
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
