import { pool } from "./db.js";

export interface NotificationRow {
  id: number;
  release_id: string;
  type: string;
  message: string;
  created_at: Date;
}

export interface NotifyReleaseInput {
  releaseId: string;
  type: string;
  message: string;
}

export async function notifyRelease({
  releaseId,
  type,
  message,
}: NotifyReleaseInput): Promise<NotificationRow | undefined> {
  const result = await pool.query<NotificationRow>(
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

export async function getReleaseNotifications(
  releaseId: string
): Promise<NotificationRow[]> {
  const result = await pool.query<NotificationRow>(
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
