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

/**
 * Read a secret without echoing it (TTY), or the whole of stdin when piped.
 */
export async function readSecret(promptText) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }

  process.stderr.write(promptText);

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const onData = (char) => {
      if (char === "\r" || char === "\n" || char === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stderr.write("\n");
        resolve(value);
      } else if (char === "\u0003") {
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        reject(new Error("Cancelled"));
      } else if (char === "\u007f" || char === "\b") {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    };

    stdin.on("data", onData);
  });
}
