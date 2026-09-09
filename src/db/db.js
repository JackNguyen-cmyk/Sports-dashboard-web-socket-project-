import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not defined');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// pg emits 'error' on the POOL when an idle client fails - a Neon read
// timeout, a dropped network, the database closing a connection it considers
// stale. That is routine, and by the time this fires the pool has already
// removed and destroyed the client, so there is nothing here to repair: the
// next query opens a fresh connection.
//
// The listener exists because an 'error' event with no listener is an uncaught
// exception. Without it, a routine idle-connection drop takes the whole
// process down - and this is not hypothetical, a load run against Neon logged
// four `read ETIMEDOUT` errors. Those happened to land mid-query, where the
// route's own try/catch caught them; the same failure on an idle client has
// nowhere else to go.
pool.on('error', (error) => {
  console.error('unexpected error on idle database client', error);
});

export const db = drizzle(pool);
