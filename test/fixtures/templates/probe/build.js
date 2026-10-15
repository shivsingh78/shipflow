import fs from "fs";

const phases = ["install", "build"].map((phase) =>
  JSON.parse(fs.readFileSync(`.probe-${phase}.json`, "utf8"))
);

fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist", { recursive: true });

fs.writeFileSync(
  "dist/index.html",
  "<!doctype html><html><head><title>ShipFlow probe</title></head><body><h1>ShipFlow sandbox probe</h1></body></html>\n"
);
fs.writeFileSync("dist/probe.json", JSON.stringify(phases, null, 2));
