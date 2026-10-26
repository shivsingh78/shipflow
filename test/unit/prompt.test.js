import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { Readable } from "stream";

import { readSecret } from "../../cli/dist/lib/prompt.js";

/** A minimal fake TTY: feed it chunks the way a terminal would. */
function fakeTty() {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    raw: null,
    paused: false,
    setRawMode(value) { this.raw = value; },
    resume() { this.paused = false; },
    pause() { this.paused = true; },
    setEncoding() {},
  });
  const output = { text: "", write(chunk) { this.text += chunk; } };
  return { input, output, type: (...chunks) => chunks.forEach((c) => input.emit("data", c)) };
}

async function read(...chunks) {
  const tty = fakeTty();
  const pending = readSecret("secret: ", { input: tty.input, output: tty.output });
  tty.type(...chunks);
  return { value: await pending, tty };
}

test("a pasted secret arrives as one chunk and still ends at Enter", async () => {
  const { value, tty } = await read("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\r");
  assert.equal(value, "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  assert.equal(tty.input.raw, false, "terminal restored");
  assert.equal(tty.input.paused, true);
});

test("pasted text ending in a newline, or typed one character at a time, works too", async () => {
  assert.equal((await read("abc123\n")).value, "abc123");
  assert.equal((await read(..."abc123".split(""), "\r")).value, "abc123");
  assert.equal((await read("abc", "123\r")).value, "abc123", "Enter in a later chunk");
});

test("the secret is never echoed; only the prompt and a newline are written", async () => {
  const { tty } = await read("super-secret-value\r");
  assert.equal(tty.output.text, "secret: \n");
  assert.doesNotMatch(tty.output.text, /super-secret/);
});

test("editing keys: backspace deletes, escape sequences and control characters are ignored", async () => {
  assert.equal((await read("abcX\u007f\u007fd\r")).value, "abd");
  assert.equal((await read("ab\u001b[Dc\u001b[A\r")).value, "abc", "arrow keys");
  assert.equal((await read("\u001b[200~pasted-token\u001b[201~\r")).value, "pasted-token", "bracketed paste markers");
  assert.equal((await read("a\tb\u0007c\r")).value, "abc");
});

test("anything after Enter is dropped, and Ctrl-D also ends input", async () => {
  assert.equal((await read("one\rtwo")).value, "one");
  assert.equal((await read("one\u0004")).value, "one");
});

test("Ctrl-C cancels without returning anything typed so far", async () => {
  const tty = fakeTty();
  const pending = readSecret("secret: ", { input: tty.input, output: tty.output });
  tty.type("partial", "\u0003");
  await assert.rejects(pending, /Cancelled/);
  assert.equal(tty.input.raw, false);
});

test("when stdin is not a terminal the whole input is read", async () => {
  const piped = Readable.from([Buffer.from("line-one\nline"), Buffer.from("-two\n")]);
  piped.isTTY = false;
  assert.equal(await readSecret("ignored", { input: piped }), "line-one\nline-two");
});
