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

  console.log("Notification created:", result.rows[0]);

  return result.rows[0];
}