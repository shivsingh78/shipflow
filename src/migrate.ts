import fs from "fs/promises";
import { fileURLToPath } from "url";

import { errorMessage } from "./errors.js";
import { pool } from "./db.js";

const MIGRATION_LOCK = 4_242_000;
const schemaPath = new URL("../../db/schema.sql", import.meta.url);

/**
 * Apply db/schema.sql. The API and worker both call this on startup; the
 * advisory lock stops them from running it at the same time.
 */
export async function runMigrations(): Promise<void> {
  const sql = await fs.readFile(schemaPath, "utf-8");
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(sql);
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK])
      .catch(() => {});
    client.release();
  }
}

// `node src/migrate.js` applies the schema and exits.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runMigrations();
    console.log("Database schema is up to date");
  } catch (error) {
    console.error("Migration failed:", errorMessage(error));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
