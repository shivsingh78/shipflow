// Minimal interactive prompts on top of node:readline (no dependencies).
import readline from "readline";

/** Where prompts read from and write to (process streams, or test fakes). */
interface PromptInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
}

interface PromptOutput {
  write(chunk: string): unknown;
}

/** A TTY input whose raw mode can be toggled. */
interface SecretInput extends PromptInput {
  setRawMode(mode: boolean): unknown;
}

export interface Choice {
  value: string;
  description: string;
}

export interface Prompter {
  ask(
    question: string,
    options?: { defaultValue?: string | undefined; validate?: ((value: string) => string | null | undefined) | undefined }
  ): Promise<string>;
  choose(question: string, choices: Choice[], defaultValue?: string): Promise<string>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  close(): void;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function createPrompter({
  input = process.stdin,
  output = process.stderr,
}: { input?: PromptInput; output?: PromptOutput & NodeJS.WritableStream } = {}): Prompter {
  const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });

  const ask: Prompter["ask"] = (question, { defaultValue = "", validate } = {}) =>
    new Promise<string>((resolve, reject) => {
      const suffix = defaultValue ? ` (${defaultValue})` : "";

      const once = () =>
        rl.question(`${question}${suffix}: `, (answer) => {
          const value = answer.trim() || defaultValue;
          const problem = validate?.(value);

          if (problem) {
            output.write(`  ${problem}\n`);
            once();
          } else {
            resolve(value);
          }
        });

      rl.once("close", () => reject(new Error("Cancelled")));
      once();
    });

  const choose: Prompter["choose"] = async (question, choices, defaultValue) => {
    output.write(`${question}\n`);
    choices.forEach((choice) =>
      output.write(`  ${choice.value.padEnd(10)} ${choice.description}\n`)
    );

    return ask("Choice", {
      defaultValue,
      validate: (value) =>
        choices.some((c) => c.value === value) ? null : `Choose one of: ${choices.map((c) => c.value).join(", ")}`,
    });
  };

  const confirm: Prompter["confirm"] = async (question, defaultYes = true) => {
    const answer = await ask(`${question} [${defaultYes ? "Y/n" : "y/N"}]`);
    if (!answer) return defaultYes;
    return /^y(es)?$/i.test(answer);
  };

  return { ask, choose, confirm, close: () => rl.close() };
}

// Terminal escape sequences (arrow keys, bracketed-paste markers, ...).
// eslint-disable-next-line no-control-regex -- ESC (0x1b) is the point: this strips ANSI escape sequences
const ESCAPE_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Read a secret without echoing it (TTY), or the whole of stdin when piped.
 *
 * A terminal delivers pasted text as one chunk (for example "secret\r"), so
 * input is processed character by character, not chunk by chunk.
 */
export async function readSecret(
  promptText: string,
  { input = process.stdin, output = process.stderr }: { input?: SecretInput; output?: PromptOutput } = {}
): Promise<string> {
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }

  output.write(promptText);

  return new Promise<string>((resolve, reject) => {
    let value = "";

    const finish = (error?: Error): void => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      output.write("\n");

      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk: unknown): void => {
      for (const char of String(chunk).replace(ESCAPE_SEQUENCE, "")) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          // Enter (or Ctrl-D) ends the secret; anything typed after it is dropped.
          return finish();
        }

        if (char === "\u0003") {
          return finish(new Error("Cancelled"));
        }

        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else if (char >= " ") {
          value += char;
        }
      }
    };

    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    input.on("data", onData);
  });
}
