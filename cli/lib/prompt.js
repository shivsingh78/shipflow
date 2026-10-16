// Minimal interactive prompts on top of node:readline (no dependencies).
import readline from "readline";

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function createPrompter({ input = process.stdin, output = process.stderr } = {}) {
  const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });

  const ask = (question, { defaultValue = "", validate } = {}) =>
    new Promise((resolve, reject) => {
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

  const choose = async (question, choices, defaultValue) => {
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

  const confirm = async (question, defaultYes = true) => {
    const answer = await ask(`${question} [${defaultYes ? "Y/n" : "y/N"}]`);
    if (!answer) return defaultYes;
    return /^y(es)?$/i.test(answer);
  };

  return { ask, choose, confirm, close: () => rl.close() };
}

// Terminal escape sequences (arrow keys, bracketed-paste markers, ...).
const ESCAPE_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Read a secret without echoing it (TTY), or the whole of stdin when piped.
 *
 * A terminal delivers pasted text as one chunk (for example "secret\r"), so
 * input is processed character by character, not chunk by chunk.
 */
export async function readSecret(promptText, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) {
    const chunks = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }

  output.write(promptText);

  return new Promise((resolve, reject) => {
    let value = "";

    const finish = (error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      output.write("\n");

      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk) => {
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
