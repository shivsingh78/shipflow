import { pool } from "./db.js";

// Serializes activations from the worker (deploy) and API (rollback).
const ACTIVATION_LOCK = 4_242_001;

/**
 * The active release is the newest row in `activations`. Switching is a
 * single INSERT, so the live site moves from one complete, immutable
 * artifact to another with no window where it is empty.
 */
export async function getActiveReleaseId() {
  const result = await pool.query(
    `SELECT release_id FROM activations ORDER BY id DESC LIMIT 1`
  );

  return result.rows[0]?.release_id ?? null;
}

export async function activateRelease({ releaseId, action }) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      ACTIVATION_LOCK,
    ]);

    const current = await client.query(
      `SELECT release_id FROM activations ORDER BY id DESC LIMIT 1`
    );

    const previousReleaseId = current.rows[0]?.release_id ?? null;

    await client.query(
      `
      INSERT INTO activations (release_id, previous_release_id, action)
      VALUES ($1, $2, $3)
      `,
      [releaseId, previousReleaseId, action]
    );

    await client.query("COMMIT");

    return { releaseId, previousReleaseId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Undo an activation whose live check failed, but only if nothing else has
 * been activated since.
 */
export async function revertActivation({ releaseId, previousReleaseId }) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      ACTIVATION_LOCK,
    ]);

    const current = await client.query(
      `SELECT release_id FROM activations ORDER BY id DESC LIMIT 1`
    );

    const reverted = current.rows[0]?.release_id === releaseId;

    if (reverted) {
      await client.query(
        `
        INSERT INTO activations (release_id, previous_release_id, action)
        VALUES ($1, $2, 'REVERT')
        `,
        [previousReleaseId, releaseId]
      );
    }

    await client.query("COMMIT");

    return reverted;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
