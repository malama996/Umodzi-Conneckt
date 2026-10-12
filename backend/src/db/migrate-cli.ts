import 'dotenv/config';
import { runMigrations } from './migrate.js';
import { pool } from './client.js';

runMigrations()
  .then(() => pool.end())
  .catch((e) => { console.error(e); process.exit(1); });
