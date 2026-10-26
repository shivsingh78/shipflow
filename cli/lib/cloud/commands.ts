// `shipflow cloud <deploy|status|destroy>`: argument parsing and the real
// (non-test) dependencies for the workflows in wizard.js.
import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import { execFile } from "child_process";
import { parseArgs, promisify } from "util";
import type { ParseArgsConfig } from "util";

import {
  checkProjectTarget,
  createRelease,
  getProject,
  listProjects,
  putProject,
  setSecret,
  setConnectionOverrides,
  whoami,
} from "../../deploy.js";
import { writeConfigFile } from "../configFile.js";
import { resolveConnection } from "../credentials.js";
import { UsageError, errorCode, errorMessage } from "../errors.js";
import { followRelease } from "../follow.js";
import { createPrompter, isInteractive, readSecret } from "../prompt.js";
import type { Prompter } from "../prompt.js";
import { createAwsClients, loadSdk } from "./aws.js";
import { createKeyDir, generateDeployKey, wipeDir } from "./keys.js";
import { createStore } from "./store.js";
import { runCloudDeploy, runCloudDestroy, runCloudStatus } from "./wizard.js";
import type { CloudDeps, CloudFlags, CloudIo, RepoCheck } from "./wizard.js";

const execFileAsync = promisify(execFile);

export const CLOUD_USAGE = [
  "Usage:",
  "  shipflow cloud deploy [options]    Create one temporary AWS EC2 VPS and deploy a repository to it",
  "  shipflow cloud status [--id ID]    Show the state and public IP of a ShipFlow-managed VPS",
  "  shipflow cloud destroy [--id ID]   Terminate a ShipFlow-managed VPS and its resources",
  "",
  "cloud deploy options (each skips the matching question):",
  "  --region R  --name N  --repo URL  --branch B  --output DIR  --instance-type T",
  "  --disk-size GiB  --ssh-cidr CIDR  --config-file FILE",
  "AWS credentials: --profile NAME, --default-credentials, or answer the prompt.",
  "  AWS keys are never accepted as command-line options.",
  "",
  "Creating and destroying always ask you to type CREATE / DESTROY; there is no --yes.",
].join("\n");

type ParseOptions = NonNullable<ParseArgsConfig["options"]>;

const COMMON: ParseOptions = {
  server: { type: "string" },
  profile: { type: "string" },
  "default-credentials": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const OPTIONS: Record<string, ParseOptions> = {
  deploy: {
    ...COMMON,
    region: { type: "string" },
    name: { type: "string" },
    repo: { type: "string" },
    branch: { type: "string" },
    output: { type: "string" },
    "instance-type": { type: "string" },
    "disk-size": { type: "string" },
    "ssh-cidr": { type: "string" },
    "config-file": { type: "string" },
  },
  status: { ...COMMON, id: { type: "string" }, json: { type: "boolean" } },
  destroy: { ...COMMON, id: { type: "string" } },
};

export function parseCloudArgs(sub: string, argv: string[]): CloudFlags {
  if (argv.some((arg) => arg === "--yes" || arg === "-y")) {
    throw new UsageError(
      `shipflow cloud ${sub}: there is no --yes. Creating or destroying billable resources always requires typing ${
        sub === "destroy" ? "DESTROY" : "CREATE"
      } yourself.`
    );
  }

  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS[sub],
      allowPositionals: true,
    });

    if (positionals.length > 0) throw new UsageError(`Unexpected argument: ${positionals[0]}`);

    return values;
  } catch (error) {
    if (error instanceof UsageError) throw error;

    const credentialFlag = /access-key|secret|token/i.test(errorMessage(error));
    throw new UsageError(
      credentialFlag
        ? "AWS credentials are never accepted as command-line options (they would end up in shell history and process lists). " +
            "Use --profile, --default-credentials, or the hidden prompt."
        : `${errorMessage(error)}\n\n${CLOUD_USAGE}`
    );
  }
}

// ----------------------------------------------------------------- terminal

function createTerminalIo({ json = false }: { json?: boolean } = {}): CloudIo {
  let prompter: Prompter | null = null;
  const interactive = isInteractive();
  const prompt = () => (prompter ??= createPrompter());

  return {
    interactive,
    print: (line: string = "") => (json ? console.error(line) : console.log(line)),
    warn: (line: string) => console.error(line),
    json: (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
    ask: (question, options) => prompt().ask(question, options),
    choose: (...args: Parameters<Prompter["choose"]>) => prompt().choose(...args),
    confirm: (...args: Parameters<Prompter["confirm"]>) => prompt().confirm(...args),
    // readline and raw-mode input cannot share stdin: hand it over cleanly.
    async secret(promptText: string) {
      prompter?.close();
      prompter = null;
      return readSecret(promptText);
    },
    close: () => prompter?.close(),
  };
}

// ------------------------------------------------------------------- deps

const cleanups = new Set<() => void>();
let interruptHandlerInstalled = false;

function registerCleanup(fn: () => void): () => boolean {
  cleanups.add(fn);

  if (!interruptHandlerInstalled) {
    interruptHandlerInstalled = true;
    process.on("SIGINT", () => {
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          // best effort: the process is exiting
        }
      }

      console.error(
        "\nInterrupted. The temporary deploy key was removed. Any AWS resources that were already created " +
          "keep running and are billed: see `shipflow cloud status` and `shipflow cloud destroy`."
      );
      process.exit(130);
    });
  }

  return () => cleanups.delete(fn);
}

async function checkRepo({ url, branch }: { url: string; branch: string }): Promise<RepoCheck> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "credential.helper=", "ls-remote", "--heads", "--", url, `refs/heads/${branch}`],
      {
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          HOME: os.tmpdir(),
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      }
    );

    return { status: stdout.trim() ? "ok" : "no-branch" };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "skipped", reason: "git is not installed" };
    if ((error as { killed?: boolean }).killed) return { status: "skipped", reason: "the check timed out" };
    return { status: "unreadable" };
  }
}

async function detectPublicIp(): Promise<string | null> {
  try {
    const response = await fetch("https://checkip.amazonaws.com", { signal: AbortSignal.timeout(5000) });
    const ip = (await response.text()).trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

export function createDefaultDeps(): CloudDeps {
  return {
    api: { whoami, listProjects, getProject, putProject, setSecret, createRelease, checkProjectTarget },
    serverUrl: () => resolveConnection().url,
    loadSdk,
    createAwsClients,
    store: createStore(),
    checkRepo,
    detectPublicIp,
    createKeyDir,
    generateDeployKey,
    wipeDir,
    removeDirSync: (dir: string) => fs.rmSync(dir, { recursive: true, force: true }),
    registerCleanup,
    writeConfig: async (config, file: string) => writeConfigFile(config, file, { overwrite: false }),
    fileExists: async (file: string) => fsp.access(file).then(() => true, () => false),
    readFile: (file: string) => fsp.readFile(file, "utf8"),
    followRelease,
    randomHex: (bytes: number) => crypto.randomBytes(bytes).toString("hex"),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

// ------------------------------------------------------------------- entry

type Workflow = (args: { flags: CloudFlags; deps: CloudDeps; io: CloudIo }) => Promise<number>;

const WORKFLOWS: Record<string, Workflow> = {
  deploy: runCloudDeploy,
  status: runCloudStatus,
  destroy: runCloudDestroy,
};

export async function runCloud(
  argv: string[],
  {
    createDeps = createDefaultDeps,
    createIo = createTerminalIo,
  }: { createDeps?: () => CloudDeps; createIo?: (options: { json?: boolean }) => CloudIo } = {}
): Promise<number> {
  const [sub, ...rest] = argv;

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(CLOUD_USAGE);
    return 0;
  }

  const workflow = WORKFLOWS[sub];

  if (!workflow) {
    throw new UsageError(`Unknown cloud command: ${sub}\n\n${CLOUD_USAGE}`);
  }

  const flags = parseCloudArgs(sub, rest);

  if (flags.help) {
    console.log(CLOUD_USAGE);
    return 0;
  }

  if (flags.server) setConnectionOverrides({ server: flags.server });

  const io = createIo({ json: Boolean(flags.json) });

  if (sub !== "status" && !io.interactive) {
    throw new UsageError(
      `shipflow cloud ${sub} asks for confirmation and must run in an interactive terminal.`
    );
  }

  try {
    return await workflow({ flags, deps: createDeps(), io });
  } finally {
    io.close?.();
  }
}
