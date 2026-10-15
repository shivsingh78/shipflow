import fs from "fs";

const html = fs.readFileSync("dist/index.html", "utf8");
const version = fs.readFileSync("VERSION", "utf8").trim();

if (!html.includes(`ShipFlow fixture ${version}`)) {
  console.error("index.html does not contain the expected version");
  process.exit(1);
}

console.log("fixture tests passed");
