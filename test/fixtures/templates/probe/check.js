// Fails the release if any phase could see ShipFlow secrets, worker files,
// or internal services.
import fs from "fs";

let failed = false;

for (const phase of ["install", "build", "test"]) {
  const result = JSON.parse(fs.readFileSync(`.probe-${phase}.json`, "utf8"));

  if (result.metadataDirect || result.internetDirect) {
    console.error(`LEAK in ${phase}: direct network access (metadata=${result.metadataDirect}, internet=${result.internetDirect})`);
    failed = true;
  }

  for (const key of ["leakedEnv", "readablePaths", "reachableInternal", "reachableGateway"]) {
    if (result[key].length > 0) {
      console.error(`LEAK in ${phase}: ${key} = ${result[key].join(", ")}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log("probe: no secrets, worker files, or internal services visible");
