import pg from 'pg';

import './config.js';

const {Pool}=pg;

export const pool = new Pool({
    host:process.env.DB_HOST || "127.0.0.1",
    port:Number(process.env.DB_PORT || 5432) ,
    user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,
    database:process.env.DB_NAME,
})

// An idle client losing its connection must not crash the process.
pool.on('error',(error)=>{
    console.error('PostgreSQL pool error:',error.message);
})
