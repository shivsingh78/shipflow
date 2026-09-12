import {pool} from './db.js';

export async function logRelease({
    releaseId,
    stage,
    level='INFO',
    message,
}){
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
            message,
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