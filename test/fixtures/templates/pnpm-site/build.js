import fs from "fs";
import escapeHtml from "escape-html";

const version = fs.readFileSync("VERSION", "utf8").trim();
const title = escapeHtml(`ShipFlow fixture ${version}`);

fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist/assets", { recursive: true });

fs.writeFileSync(
  "dist/index.html",
  `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <link rel="stylesheet" href="/assets/style.css">
  </head>
  <body>
    <h1 id="version">${title}</h1>
    <script src="/assets/app.js"></script>
  </body>
</html>
`
);

fs.writeFileSync(
  "dist/assets/app.js",
  `document.body.dataset.version = ${JSON.stringify(version)};\n`
);

fs.writeFileSync("dist/assets/style.css", "h1 { font-family: sans-serif; }\n");

console.log(`built ${version}`);
