// Reading and writing shipflow.yml.
import fs from "fs";
import path from "path";
import YAML from "yaml";

import { validateProjectConfig, ProjectConfigError } from "./projectConfig.js";
import type { ProjectConfig } from "./projectConfig.js";
import { errorMessage } from "./errors.js";

export const DEFAULT_CONFIG_FILE = "shipflow.yml";

export function loadConfigFile(file = DEFAULT_CONFIG_FILE): { file: string; config: ProjectConfig } {
  const full = path.resolve(file);
  let text: string;

  try {
    text = fs.readFileSync(full, "utf8");
  } catch {
    throw new ProjectConfigError([
      { path: file, message: "not found; create one with `shipflow init`" },
    ]);
  }

  let parsed: unknown;

  try {
    // Plain YAML only: no custom tags, no anchors merging tricks.
    parsed = YAML.parse(text, { customTags: [], merge: false, maxAliasCount: 0 });
  } catch (error) {
    throw new ProjectConfigError([
      { path: file, message: `is not valid YAML: ${errorMessage(error).split("\n")[0]}` },
    ]);
  }

  return { file: full, config: validateProjectConfig(parsed) };
}

/**
 * Serialize a configuration in a readable order, omitting defaults that the
 * user did not choose.
 */
export function renderConfig(config: ProjectConfig): string {
  const doc: Record<string, unknown> = {
    version: config.version,
    project: config.project,
    build: Object.fromEntries(
      Object.entries(config.build).filter(([key, value]) =>
        key === "env" ? Object.keys(value as object).length > 0 : value !== "auto"
      )
    ),
    deployment: config.deployment,
    verification: config.verification,
    github: config.github,
  };

  if (Object.keys(doc.build as object).length === 0) delete doc.build;

  const header = [
    "# ShipFlow project configuration (https://github.com/shivsingh78/shipflow)",
    "# Do NOT put secrets here. Store them on the server with:",
    "#   shipflow secrets set <NAME> --project <project>",
    "",
  ].join("\n");

  return header + YAML.stringify(doc, { lineWidth: 0 });
}

export function writeConfigFile(
  config: ProjectConfig,
  file = DEFAULT_CONFIG_FILE,
  { overwrite = false }: { overwrite?: boolean } = {}
): string {
  const full = path.resolve(file);

  if (!overwrite && fs.existsSync(full)) {
    throw new Error(`${file} already exists; use --force to overwrite`);
  }

  fs.writeFileSync(full, renderConfig(config));
  return full;
}
