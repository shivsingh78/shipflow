import { spawn } from "child_process";

const SECRET_NAME = /(SECRET|PASSWORD|TOKEN|ACCESS_KEY|PRIVATE)/i;

/**
 * Replace values of secret-looking environment variables in text.
 * A second line of defence: secrets should never reach build output at all.
 */
export function redactSecrets(text, env = process.env) {
  let result = String(text);

  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && value && value.length >= 6) {
      result = result.split(value).join("[REDACTED]");
    }
  }

  return result;
}

export class CommandError extends Error {
  constructor(message, result) {
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
  command,
  args,
  {
    cwd,
    env,
    timeoutMs = 60_000,
    maxOutputBytes = 64 * 1024,
    onTimeout,
  } = {}
) {
  return new Promise((resolve) => {
    let output = "";
    let truncated = false;
    let timedOut = false;

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (chunk) => {
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

    const finish = (exitCode, signal, spawnError) => {
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
export async function runCommandOrThrow(label, command, args, options) {
  const result = await runCommand(command, args, options);

  if (result.timedOut) {
    throw new CommandError(
      `${label} timed out after ${Math.round(options.timeoutMs / 1000)}s`,
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
