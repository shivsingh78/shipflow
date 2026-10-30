import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const allCss = ["tokens", "base", "components", "layout"].map((name) => read(`src/styles/${name}.css`)).join("\n");

describe("styles stay within the strict CSP", () => {
  it("load no resource from another origin (the CSP only allows this origin)", () => {
    expect(allCss).not.toMatch(/url\(\s*["']?(https?:)?\/\//i);
    expect(allCss).not.toMatch(/@import\s+(url\()?["']?https?:/i);
    expect(read("index.html")).not.toMatch(/(src|href)=["']https?:\/\//i);
  });

  it("runs no inline script (script-src is 'self'); the theme script is a same-origin file", () => {
    const html = read("index.html");

    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).toMatch(/<script src="\/ui\/theme-init\.js"><\/script>/);
    expect(fs.existsSync(path.join(root, "public/theme-init.js"))).toBe(true);
  });

  it("self-host every font it declares", () => {
    const urls = [...allCss.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1] ?? "");

    expect(urls.length).toBeGreaterThanOrEqual(4);

    for (const url of urls) {
      expect(url).toMatch(/^\/ui\/fonts\/[\w-]+\.woff2$/);
      expect(fs.existsSync(path.join(root, "public", url.replace(/^\/ui\//, ""))), `${url} is shipped in public/`).toBe(true);
    }
  });

  it("uses Inter for text and IBM Plex Mono for code, and ships their licenses", () => {
    expect(allCss).toMatch(/font-family:\s*"Inter"/);
    expect(allCss).toMatch(/font-family:\s*"IBM Plex Mono"/);
    expect(allCss).toMatch(/--font-sans:\s*"Inter"/);
    expect(allCss).toMatch(/--font-mono:\s*"IBM Plex Mono"/);

    for (const license of ["OFL-Inter.txt", "OFL-IBM-Plex-Mono.txt"]) {
      expect(read(`public/fonts/${license}`)).toMatch(/SIL Open Font License, Version 1\.1/);
    }

    // The previous typefaces are gone, not left behind as dead weight.
    expect(fs.existsSync(path.join(root, "public/fonts/sora-latin.woff2"))).toBe(false);
    expect(fs.existsSync(path.join(root, "public/fonts/manrope-latin.woff2"))).toBe(false);
  });
});

// ------------------------------------------------------------------- themes

/** custom properties declared in the first block that matches `selector`. */
function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);

  if (start < 0) throw new Error(`no block for ${selector}`);

  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
  const vars: Record<string, string> = {};

  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[match[1] as string] = (match[2] as string).trim();

  return vars;
}

const tokens = read("src/styles/tokens.css");
const light = block(tokens, ":root");
const dark = { ...light, ...block(tokens, ':root[data-theme="dark"]') };

describe("themes", () => {
  it("define a light and a dark theme with the teal primary, not the old orange", () => {
    expect(light["--accent"]).toMatch(/oklch\([\d.]+% [\d.]+ 18\d\)/);
    expect(dark["--accent"]).toMatch(/oklch\([\d.]+% [\d.]+ 18\d\)/);
    expect(tokens).toMatch(/color-scheme:\s*light/);
    expect(tokens).toMatch(/color-scheme:\s*dark/);
    expect(tokens).not.toMatch(/ 36\)/); // hue 36 was the orange
  });

  it("override the same surface, text, status and terminal tokens in dark", () => {
    const darkOnly = block(tokens, ':root[data-theme="dark"]');

    for (const name of ["--bg", "--surface", "--surface-2", "--border", "--text", "--text-muted", "--accent", "--accent-text", "--success", "--danger", "--warning", "--info", "--sb-bg", "--log-bg", "--overlay", "--shadow-md"]) {
      expect(darkOnly[name], `${name} has a dark value`).toBeDefined();
      expect(darkOnly[name]).not.toBe(light[name]);
    }
  });

  it("keep component CSS on tokens: no colour literals outside tokens.css", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);

        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith(".css") && entry.name !== "tokens.css") {
          const text = fs.readFileSync(file, "utf8");

          if (/#[0-9a-fA-F]{3,8}\b|oklch\(|rgba?\(|hsla?\(/.test(text)) offenders.push(path.relative(root, file));
        }
      }
    };

    walk(path.join(root, "src"));
    expect(offenders).toEqual([]);
  });
});

// ----------------------------------------------------------------- contrast

function srgb(l: number, c: number, h: number): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_];

  return rgb.map((v) => Math.min(1, Math.max(0, v))) as [number, number, number];
}

function luminance(value: string, vars: Record<string, string>): number {
  let resolved = value;

  for (let i = 0; i < 5 && resolved.startsWith("var("); i += 1) resolved = vars[resolved.slice(4, -1)] ?? resolved;

  const match = /^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/.exec(resolved);

  if (!match) throw new Error(`cannot evaluate ${value}`);

  const [r, g, b] = srgb(Number(match[1]) / 100, Number(match[2]), Number(match[3]));

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string, vars: Record<string, string>): number {
  const [hi, lo] = [luminance(foreground, vars), luminance(background, vars)].sort((x, y) => y - x) as [number, number];

  return (hi + 0.05) / (lo + 0.05);
}

describe("colour contrast (WCAG AA, 4.5:1 for text) in both themes", () => {
  const PAIRS: Array<[string, string]> = [
    ["--text", "--bg"],
    ["--text", "--surface"],
    ["--text", "--surface-2"],
    ["--text-muted", "--bg"],
    ["--text-muted", "--surface"],
    ["--text-subtle", "--surface"],
    ["--accent", "--bg"],
    ["--accent", "--surface"],
    ["--accent-text", "--accent"],
    ["--success", "--surface"],
    ["--danger", "--surface"],
    ["--warning", "--surface"],
    ["--info", "--surface"],
    ["--sb-text", "--sb-bg"],
    ["--sb-text-strong", "--sb-bg"],
    ["--sb-muted", "--sb-bg"],
    ["--log-text", "--log-bg"],
    ["--log-muted", "--log-bg"],
    ["--log-warn", "--log-bg"],
    ["--log-error", "--log-bg"],
  ];

  for (const [name, vars] of [["light", light], ["dark", dark]] as const) {
    it(`${name} theme`, () => {
      const failures = PAIRS.map(([fg, bg]) => ({ pair: `${fg} on ${bg}`, ratio: contrast(`var(${fg})`, `var(${bg})`, vars) })).filter((r) => r.ratio < 4.5);

      expect(failures.map((f) => `${f.pair} = ${f.ratio.toFixed(2)}`)).toEqual([]);
    });
  }
});
