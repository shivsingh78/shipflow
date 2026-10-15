import {pool} from './db.js';

// Keep individual log rows bounded; build output is already tail-truncated.
const MAX_MESSAGE_LENGTH = 16 * 1024;

export async function logRelease({
    releaseId,
    stage,
    level='INFO',
    message,
}){
    const text = String(message);
    const result = await pool.query(
        `
        INSERT INTO release_logs
         (release_id, stage,level,message)
         VALUES
         ($1,$2,$3,$4)
         RETURNING *
        `,
        [
            releaseId,
            stage,
            level,
            text.length > MAX_MESSAGE_LENGTH
                ? `[truncated]\n${text.slice(-MAX_MESSAGE_LENGTH)}`
                : text,
        ]
    );
    return result.rows[0];
}

export async function getReleaseLogs(releaseId){
    const result = await pool.query(
        `
        SELECT id,release_id,stage,level,message,created_at FROM release_logs WHERE release_id=$1
        ORDER BY id ASC
        `,
        [releaseId]
    )
    return result.rows;
}
