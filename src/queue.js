import { Queue } from "bullmq";
import IORedis from "ioredis"

const connection = new IORedis({
    host : process.env.REDIS_HOST || "127.0.0.1",
    port:Number( process.env.REDIS_PORT || 6379),
    maxRetriesPerRequest:null,
})

export const deployQueue = new Queue(
    "deployment-queue",
    {
        connection
    }
) 
