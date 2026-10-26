import http from "node:http";
http.createServer((_req, res) => res.end("ok")).listen(Number(process.env.PORT ?? 3000));
