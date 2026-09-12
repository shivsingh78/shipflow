#!/usr/bin/env node

import {
  createRelease,
  getReleaseStatus,
  getAllReleases,
  getReleaseLogs
} from "./deploy.js";

const command = process.argv[2];

console.log("🚀 ShipFlow CLI");

/*
|--------------------------------------------------------------------------
| DEPLOY
|--------------------------------------------------------------------------
*/

if (command === "deploy") {
  try {
    const repoUrl = process.argv[3];

    if (!repoUrl) {
      console.error(
        "Usage: shipflow deploy <repoUrl>"
      );

      process.exit(1);
    }

    console.log("");
    console.log(
      `Deploying: ${repoUrl}`
    );

    // Create release
    const result =
      await createRelease(repoUrl);

    const release =
      result.release;

    console.log("");
    console.log(
      `Release: ${release.release_id}`
    );

    let lastStage = null;

    // Poll release status
    while (true) {
      const statusResult =
        await getReleaseStatus(
          release.release_id
        );

      const current =
        statusResult.release;

      if (
        current.current_stage !== lastStage
      ) {
        console.log(
          `→ ${current.current_stage} (${current.status})`
        );

        lastStage =
          current.current_stage;
      }

      // Success
      if (current.status === "SUCCESS") {
        console.log("");
        console.log(
          "✅ Deployment successful"
        );

        if (current.public_deployment_url) {
          console.log(
            `URL: ${current.public_deployment_url}`
          );
        }

        break;
      }

      // Failure
      if (current.status === "FAILED") {
        console.error("");
        console.error(
          "❌ Deployment failed"
        );

        console.error(
          `Stage: ${current.current_stage}`
        );

        if (current.error_message) {
          console.error(
            `Reason: ${current.error_message}`
          );
        }

        process.exit(1);
      }

      // Wait 2 seconds before polling again
      await new Promise(
        (resolve) =>
          setTimeout(resolve, 2000)
      );
    }
  } catch (error) {
    console.error("");
    console.error(
      "❌",
      error.message
    );

    process.exit(1);
  }

  process.exit(0);
}

/*
|--------------------------------------------------------------------------
| STATUS
|--------------------------------------------------------------------------
*/

if (command === "status") {
  try {
    const releaseId =
      process.argv[3];

    if (!releaseId) {
      console.error(
        "Usage: shipflow status <releaseId>"
      );

      process.exit(1);
    }

    const result =
      await getReleaseStatus(
        releaseId
      );

    const release =
      result.release;

    console.log("");
    console.log(
      `Release: ${release.release_id}`
    );

    console.log(
      `Repository: ${release.repo_url}`
    );

    console.log(
      `Status: ${release.status}`
    );

    console.log(
      `Stage: ${release.current_stage}`
    );

    if (
      release.public_deployment_url
    ) {
      console.log(
        `URL: ${release.public_deployment_url}`
      );
    }

    if (
      release.artifact_path
    ) {
      console.log(
        `Artifact: ${release.artifact_path}`
      );
    }

    if (
      release.error_message
    ) {
      console.log(
        `Error: ${release.error_message}`
      );
    }

    console.log(
      `Created: ${release.created_at}`
    );

    console.log(
      `Updated: ${release.updated_at}`
    );
  } catch (error) {
    console.error("");
    console.error(
      "❌",
      error.message
    );

    process.exit(1);
  }

  process.exit(0);
}

/*
|--------------------------------------------------------------------------
| RELEASES
|--------------------------------------------------------------------------
*/

if(command === "releases") {
  try {
    const result = await getAllReleases();
    const releases = result.releases;
    console.log("");
    console.log("ShipFlow Releases");
    console.log("");

    if(releases.length ===0){
      console.log(
        "No releases found."
      );

      process.exit(0);
      
    }

    console.log(     "RELEASE\tSTATUS\tSTAGE\tCREATED");

    for(const release of releases){
      console.log( `${release.release_id}\t${release.status}\t${release.current_stage}\t${release.created_at}`);
      
    }
     

  }catch(error){
console.error("");
    console.error(
      "❌",
      error.message
    );

    process.exit(1);
  }

  process.exit(0);
  }

  /*
|--------------------------------------------------------------------------
| LOGS
|--------------------------------------------------------------------------
*/

if(command === "logs"){
  try {
    const releaseId = process.argv[3];

    if(!releaseId) {
      console.error(
        "Usage: shipflow logs <releaseId>"
      );
      process.exit(1);
    }

    const result = await getReleaseLogs(releaseId);

    console.log("");
    if(result.logs.length === 0){
      console.log("No logs found.");
      process.exit(0);

    }

    for(const log of result.logs){
      console.log(`[${log.stage}] [${log.level}] ${log.message}`)
    }
    
    
  } catch (error) {
    console.error("");
    console.error(
      "❌",
      error.message
    );

    process.exit(1);
  }

    process.exit(0);
  }


/*

|--------------------------------------------------------------------------
| HELP
|--------------------------------------------------------------------------
*/

console.log("");
console.log("Commands:");
console.log(
  "  shipflow deploy <repoUrl>"
);
console.log(
  "  shipflow status <releaseId>"
);
console.log(
  "  shipflow releases"
);
console.log(
  "  shipflow logs <releaseId>"
);