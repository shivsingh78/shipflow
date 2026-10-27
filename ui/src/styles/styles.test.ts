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

  it("self-host every font it declares", () => {
    const urls = [...allCss.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1] ?? "");

    expect(urls.length).toBeGreaterThanOrEqual(2);

    for (const url of urls) {
      expect(url).toMatch(/^\/ui\/fonts\/[\w-]+\.woff2$/);
      expect(fs.existsSync(path.join(root, "public", url.replace(/^\/ui\//, ""))), `${url} is shipped in public/`).toBe(true);
    }
  });

  it("declares the display and text families used by the design", () => {
    expect(allCss).toMatch(/font-family:\s*"Sora"/);
    expect(allCss).toMatch(/font-family:\s*"Manrope"/);
    expect(allCss).toMatch(/--font-display:\s*"Sora"/);
  });

  it("defines a single dark theme (the design has no light variant)", () => {
    expect(allCss).toMatch(/color-scheme:\s*dark/);
    expect(allCss).not.toMatch(/\[data-theme="light"\]/);
  });
});
