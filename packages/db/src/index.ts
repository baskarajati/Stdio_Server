import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index';

export type Database = ReturnType<typeof createDatabase>;

/** Opens a connection pool and returns a typed client. */
export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema, casing: 'snake_case' });
}

export { schema };
export { seedDatabase } from './seed';
