// Fixture API for the image pipeline. Never echoes the value of API_TOKEN.
import http from "node:http";

const VERSION = "v1";
const port = Number(process.env.PORT ?? 3000);

http
  .createServer((req, res) => {
    if (req.url === "/has-secret") {
      res.end(process.env.API_TOKEN ? "yes" : "no");
    } else if (req.url === "/greeting") {
      res.end(process.env.GREETING ?? "");
    } else {
      res.end(`api ${VERSION}`);
    }
  })
  .listen(port, () => console.log(`api ${VERSION} listening on ${port}`));
