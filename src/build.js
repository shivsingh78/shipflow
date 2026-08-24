import fs from 'fs/promises';
import path from 'path'
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function readPackageJson(projectPath) {
    const packageJsonPath = path.join(
        projectPath,
        "package.json"
    )
    try {
        const content = await fs.readFile(
            packageJsonPath,
            "utf-8"
        );
        return JSON.parse(content);
        
    } catch (error) {
        throw new Error(`Unable to read package.json : ${error.message}`
        )
        
    }
}

function detectPackageManager(packageJson) {
    const packageManager = packageJson.packageManager;

    if(packageManager?.startsWith("pnpm@")){
        return "pnpm"
    }
    if(packageManager?.startsWith("npm@")){
        return "npm"
    }
    if(packageManager?.startsWith("yarn@")){
        return "yarn"
    }
     if(packageManager?.startsWith("bun@")){
        return "bun"
    }

    //Default for now
    return "pnpm"
}

export async function buildRelease({
    releaseId,
    workspacePath,
}){
    console.log(`Building release ${releaseId}`);
    console.log(`Workspace ${workspacePath}`);

    const packageJson = await readPackageJson(workspacePath);

    const scripts =packageJson.scripts || {};

    if(!scripts.build) {
        throw new Error(
            "No build script found in package.json"
        )
    }

    const packageManager = detectPackageManager(packageJson);

    console.log(`Package manager: ${packageManager}`);

     console.log(
    `Build script: ${scripts.build}`
  );

  if(packageManager === "pnpm"){
    console.log("Installing dependencies...");
    await execFileAsync(
        "pnpm",
        ["install", "--frozen-lockfile"],
        {
            cwd: workspacePath,
        }
    )
     console.log("Running build...");

     await execFileAsync(
        "pnpm",
        ["run", "build"],
        {
            cwd:workspacePath,
        }
     )
    
  }
 if (packageManager === "npm") {
    console.log("Installing dependencies...");

    await execFileAsync(
      "npm",
      ["ci"],
      {
        cwd: workspacePath,
      }
    );

    console.log("Running build...");

    await execFileAsync(
      "npm",
      ["run", "build"],
      {
        cwd: workspacePath,
      }
    );
  }

  if (packageManager === "yarn") {
    console.log("Installing dependencies...");

    await execFileAsync(
      "yarn",
      ["install", "--frozen-lockfile"],
      {
        cwd: workspacePath,
      }
    );

    console.log("Running build...");

    await execFileAsync(
      "yarn",
      ["build"],
      {
        cwd: workspacePath,
      }
    );
  }
  if (packageManager === "bun") {
    console.log("Installing dependencies...");

    await execFileAsync(
      "bun",
      ["install", "--frozen-lockfile"],
      {
        cwd: workspacePath,
      }
    );

    console.log("Running build...");

    await execFileAsync(
      "bun",
      ["build"],
      {
        cwd: workspacePath,
      }
    );
  }

  console.log(
    `Build completed for ${releaseId}`
  );

  return {
    releaseId,
    workspacePath,
  };
}

    
