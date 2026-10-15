import { pool } from "./db.js";

export async function notifyRelease({
  releaseId,
  type,
  message,
}) {
  const result = await pool.query(
    `
    INSERT INTO notifications
      (release_id, type, message)
    VALUES
      ($1, $2, $3)
    RETURNING *
    `,
    [releaseId, type, message]
  );

  console.log(`Notification ${type}: ${message}`);

  return result.rows[0];
}

export async function getReleaseNotifications(releaseId) {
  const result = await pool.query(
    `
    SELECT id, release_id, type, message, created_at
    FROM notifications
    WHERE release_id = $1
    ORDER BY id ASC
    `,
    [releaseId]
  );

  return result.rows;
}
