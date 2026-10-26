// The shipped examples must stay valid shipflow.yml files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";

import { validateProjectConfig } from "../../cli/dist/lib/projectConfig.js";

const dir = fileURLToPath(new URL("../../examples/", import.meta.url));

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".shipflow.yml"))) {
  test(`example ${file} is valid`, () => {
    const config = validateProjectConfig(parse(fs.readFileSync(path.join(dir, file), "utf8")));
    assert.ok(config.deployment.target);
  });
}
