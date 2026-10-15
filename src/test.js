import { config } from "./config.js";
import {
  classifyTestScript,
  runScriptCommand,
} from "./packageManager.js";

/**
 * Run the repository's test script in the sandbox.
 *
 * Returns testStatus "PASSED" when tests actually ran and passed, or
 * "SKIPPED" when there is no real test script (only allowed when
 * SHIPFLOW_REQUIRE_TESTS is not "true"). Failing tests throw.
 */
export async function testRelease({
  releaseId,
  workspacePath,
  sandbox,
  packageJson,
  packageManager,
  testConfig = "auto",
  log = async () => {},
}) {
  if (testConfig === "none") {
    if (config.requireTests) {
      throw new Error("Tests are required but build.test is \"none\"");
    }

    await log("Tests SKIPPED: disabled in configuration (build.test: none)", "WARN");
    return { releaseId, workspacePath, testStatus: "SKIPPED" };
  }

  if (testConfig !== "auto") {
    await log(`Test command: ${testConfig}`);

    const result = await sandbox.exec("Tests", ["sh", "-c", testConfig], {
      timeoutMs: config.testTimeoutMs,
    });

    await log(`Test output:\n${result.output}`);
    return { releaseId, workspacePath, testStatus: "PASSED" };
  }

  const kind = classifyTestScript(packageJson);

  if (kind !== "PRESENT") {
    const reason =
      kind === "MISSING"
        ? 'no "test" script in package.json'
        : 'the "test" script is the npm placeholder';

    if (config.requireTests) {
      throw new Error(`Tests are required but ${reason}`);
    }

    await log(`Tests SKIPPED: ${reason}`, "WARN");

    return {
      releaseId,
      workspacePath,
      testStatus: "SKIPPED",
    };
  }

  await log(`Test script: ${packageJson.scripts.test}`);

  const result = await sandbox.exec(
    "Tests",
    runScriptCommand(packageManager, "test"),
    { timeoutMs: config.testTimeoutMs }
  );

  await log(`Test output:\n${result.output}`);

  return {
    releaseId,
    workspacePath,
    testStatus: "PASSED",
  };
}
