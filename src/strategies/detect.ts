import fs from "fs/promises";
import path from "path";

import { IMAGE_TARGETS } from "../../cli/lib/projectConfig.js";
import type { BuildConfig, RuntimeConfig } from "../../cli/lib/projectConfig.js";
import { readPackageJson } from "../packageManager.js";
import type { PackageJson } from "../packageManager.js";
import { DetectionError } from "./types.js";
import type { Detection, StrategyId } from "./types.js";

export interface DetectInput {
  workspacePath: string;
  build: BuildConfig;
  targetName: string;
  /** Needed for image targets (runtime.start counts as a start command). */
  runtime?: RuntimeConfig | null;
}

const STATIC_BUILD_TOOLS = /\b(vite|react-scripts|vue-cli-service|parcel|astro|webpack|gatsby|ng build)\b/;
const SERVER_ENTRIES = ["server.js", "server.mjs", "server.ts", "app.js", "index.js", "src/server.js", "src/server.ts"];

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isFile();
  } catch {
    return false;
  }
}

/** A frontend build with no server: a build script from a known static tool and no server entry. */
async function looksStaticOnly(workspacePath: string, packageJson: PackageJson): Promise<boolean> {
  const build = packageJson.scripts?.build;

  if (!build || !STATIC_BUILD_TOOLS.test(build)) {
    return false;
  }

  for (const entry of SERVER_ENTRIES) {
    if (await isFile(path.join(workspacePath, entry))) {
      return false;
    }
  }

  return true;
}

function compatible(strategy: StrategyId, imageTarget: boolean): boolean {
  return imageTarget ? strategy !== "static" : strategy === "static";
}

export async function detectStrategy({ workspacePath, build, targetName, runtime = null }: DetectInput): Promise<Detection> {
  const imageTarget = IMAGE_TARGETS.includes(targetName);

  if (build.strategy && !compatible(build.strategy, imageTarget)) {
    throw new DetectionError(
      imageTarget
        ? `build.strategy "${build.strategy}" produces static files, but target "${targetName}" runs container images; use "node" or "dockerfile"`
        : `build.strategy "${build.strategy}" produces a container image, but target "${targetName}" serves static files; use "static" or an image target (docker, kubernetes)`
    );
  }

  if (imageTarget && !runtime) {
    throw new DetectionError(
      `Target "${targetName}" runs container images, but shipflow.yml has no runtime section; add at least runtime.port`
    );
  }

  if (build.strategy) {
    return { strategy: build.strategy, reason: `build.strategy is set to "${build.strategy}" in shipflow.yml` };
  }

  if (!imageTarget) {
    return { strategy: "static", reason: `target "${targetName}" serves static files` };
  }

  const dockerfile = build.dockerfile ?? "Dockerfile";
  const hasDockerfile = await isFile(path.join(workspacePath, dockerfile));
  const packageJson: PackageJson | null = await readPackageJson(workspacePath).catch(() => null);

  const hasStart = Boolean(runtime?.start?.trim() || packageJson?.scripts?.start?.trim());

  if (hasDockerfile) {
    return {
      strategy: "dockerfile",
      reason:
        `found ${dockerfile}` +
        (hasStart ? ' (a "start" script also exists; the Dockerfile takes precedence)' : ""),
    };
  }

  if (build.dockerfile) {
    throw new DetectionError(`build.dockerfile is "${build.dockerfile}" but that file does not exist in the repository`);
  }

  if (packageJson && hasStart) {
    if (await looksStaticOnly(workspacePath, packageJson)) {
      throw new DetectionError(
        `Repository looks like a static frontend (build script "${packageJson.scripts?.build}", no server entry) ` +
          `but target "${targetName}" runs container images. Use a static target (shipflow, ssh), add a Dockerfile, ` +
          `or set build.strategy: node if it really is a server`
      );
    }

    return {
      strategy: "node",
      reason: runtime?.start ? "no Dockerfile; using runtime.start as the start command" : 'no Dockerfile; package.json has a "start" script',
    };
  }

  const found = [
    "Dockerfile: not found",
    packageJson ? 'package.json: found, no "start" script' : "package.json: not found",
    "runtime.start: not set",
  ].join("; ");

  throw new DetectionError(
    `Cannot decide how to build this repository for target "${targetName}" (${found}). ` +
      `Fix one of: add a Dockerfile (or set build.dockerfile), add a "start" script to package.json, ` +
      `set runtime.start in shipflow.yml, or set build.strategy explicitly.`
  );
}
