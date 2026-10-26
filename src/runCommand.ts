import { spawn } from "child_process";

const SECRET_NAME = /(SECRET|PASSWORD|TOKEN|ACCESS_KEY|PRIVATE)/i;

/**
 * Replace values of secret-looking environment variables in text.
 * A second line of defence: secrets should never reach build output at all.
 */
export function redactSecrets(
  text: unknown,
  env: NodeJS.ProcessEnv = process.env
): string {
  let result = String(text);

  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && value && value.length >= 6) {
      result = result.split(value).join("[REDACTED]");
    }
  }

  return result;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: string;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onTimeout?: () => unknown;
}

export class CommandError extends Error {
  result: CommandResult;

  constructor(message: string, result: CommandResult) {
    super(message);
    this.name = "CommandError";
    this.result = result;
  }
}

/**
 * Run a command without a shell, keeping only the last `maxOutputBytes`
 * of combined stdout/stderr so large outputs cannot exhaust memory.
 */
export function runCommand(
  command: string,
  args: string[],
  {
    cwd,
    env,
    timeoutMs = 60_000,
    maxOutputBytes = 64 * 1024,
    onTimeout,
  }: RunCommandOptions = {}
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let output = "";
    let truncated = false;
    let timedOut = false;

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (chunk: Buffer | string): void => {
      output += chunk.toString("utf8");

      if (output.length > maxOutputBytes) {
        output = output.slice(-maxOutputBytes);
        truncated = true;
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(async () => {
      timedOut = true;
      child.kill("SIGKILL");

      if (onTimeout) {
        try {
          await onTimeout();
        } catch {
          // The command already failed; cleanup errors are secondary.
        }
      }
    }, timeoutMs);

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: Error
    ): void => {
      clearTimeout(timer);

      if (spawnError) {
        append(`\n${spawnError.message}\n`);
      }

      resolve({
        exitCode,
        signal,
        timedOut,
        output: (truncated ? "[output truncated]\n" : "") + output,
      });
    };

    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/**
 * Like runCommand, but throws a CommandError when the command fails.
 */
export async function runCommandOrThrow(
  label: string,
  command: string,
  args: string[],
  options?: RunCommandOptions
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);

  if (result.timedOut) {
    throw new CommandError(
      `${label} timed out after ${Math.round((options?.timeoutMs ?? 60_000) / 1000)}s`,
      result
    );
  }

  if (result.exitCode !== 0) {
    throw new CommandError(
      `${label} failed with exit code ${result.exitCode ?? result.signal}`,
      result
    );
  }

  return result;
}
