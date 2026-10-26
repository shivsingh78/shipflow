import { Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { Redis as IORedis } from "ioredis"

import "./config.js"

export const connection = new IORedis({
    host : process.env.REDIS_HOST || "127.0.0.1",
    port:Number( process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest:null,
})

// bullmq bundles its own ioredis copy (different patch version), so the same
// client is structurally identical but nominally incompatible; use this for
// bullmq's `connection` option (Queue / Worker).
export const bullConnection = connection as unknown as ConnectionOptions

/** Payload of a job on the deployment queue. */
export interface ReleaseJobData {
    releaseId: string
}

export const deployQueue = new Queue<ReleaseJobData>(
    "deployment-queue",
    {
        connection: bullConnection
    }
)
