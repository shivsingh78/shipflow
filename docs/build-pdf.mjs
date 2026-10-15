// Builds docs/ShipFlow-Technical-Documentation.pdf from the Markdown source.
//
// Documentation tooling only: it is NOT part of the application and the
// application's package.json is not touched. Dependencies are installed in a
// separate directory:
//
//   mkdir /tmp/docbuild && cd /tmp/docbuild && npm init -y
//   npm install marked mermaid puppeteer-core
//   DOCBUILD_DIR=/tmp/docbuild CHROME_PATH=$(command -v google-chrome) \
//     node docs/build-pdf.mjs
//
// Steps: extract the ```mermaid blocks (writes docs/diagrams/*.mmd and
// *.svg), render the Markdown to HTML, render diagrams and print to PDF with
// headless Chrome. The table of contents is filled in with real page numbers
// in a second pass using docs/pdf-page-index.py (needs PyMuPDF; optional).

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = process.env.DOCBUILD_DIR || "/tmp/docbuild";
const CHROME = process.env.CHROME_PATH || "google-chrome";
const PYTHON = process.env.DOC_PYTHON || "python3";
const require = createRequire(path.join(BUILD_DIR, "noop.js"));
const { marked } = require("marked");
const puppeteer = require("puppeteer-core");
const mermaidPath = require.resolve("mermaid/dist/mermaid.min.js");

const SRC = path.join(here, "ShipFlow-Technical-Documentation.md");
const OUT = path.join(here, "ShipFlow-Technical-Documentation.pdf");
const DIAGRAMS = path.join(here, "diagrams");
const PAGE_INDEX = path.join(here, "pdf-page-index.py");

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// ---------------------------------------------------------------- markdown

let md = fs.readFileSync(SRC, "utf8");

// Cover content is generated; drop the H1 and the italic subtitle.
md = md.replace(/^# .*\n+/, "").replace(/^\*[^\n]+\*\n+/, "");

fs.mkdirSync(DIAGRAMS, { recursive: true });
for (const f of fs.readdirSync(DIAGRAMS)) {
  if (/\.(mmd|svg)$/.test(f)) fs.rmSync(path.join(DIAGRAMS, f));
}

const diagrams = [];

md = md.replace(/```mermaid\n([\s\S]*?)```/g, (_, source) => {
  const title = source.match(/^%% title: (.+)$/m)?.[1] ?? `Diagram ${diagrams.length + 1}`;
  const slug = slugify(title.split("—")[0] + "-" + (title.split("—")[1] || ""));
  const index = diagrams.length;

  diagrams.push({ title, slug, source });
  fs.writeFileSync(path.join(DIAGRAMS, `${slug}.mmd`), source);

  const landscape = /^%% layout: landscape$/m.test(source);
  const maxHeight = source.match(/^%% maxheight: (\d+)$/m)?.[1];

  return (
    `\n<figure class="diagram${landscape ? " landscape" : ""}" id="fig-${index}"` +
    `${maxHeight ? ` style="--maxh:${maxHeight}mm"` : ""}>` +
    `<pre class="mermaid" data-index="${index}">${esc(source)}</pre>` +
    `<figcaption>${esc(title)}</figcaption></figure>\n`
  );
});

// First blockquote is the "how to read" legend: keep it, styled as a callout.
const headings = [];

const renderer = new marked.Renderer();
renderer.heading = function ({ tokens, depth }) {
  const text = this.parser.parseInline(tokens);
  const plain = text.replace(/<[^>]+>/g, "");
  const id = slugify(plain);

  if (depth === 2 || depth === 3) {
    headings.push({ depth, id, text: plain });
  }

  return `<h${depth} id="${id}">${text}</h${depth}>\n`;
};
renderer.table = function (token) {
  const header = token.header.map((c) => this.tablecell(c)).join("");
  const body = token.rows
    .map((row) => `<tr>${row.map((c) => this.tablecell(c)).join("")}</tr>`)
    .join("\n");
  return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>\n`;
};
renderer.tablecell = function (token) {
  const tag = token.header ? "th" : "td";
  return `<${tag}>${this.parser.parseInline(token.tokens)}</${tag}>`;
};

marked.setOptions({ gfm: true, breaks: false });
let bodyHtml = marked.parse(md, { renderer });

// A landscape diagram, its heading and its first paragraph share one
// landscape page; later paragraphs continue on a portrait page.
bodyHtml = bodyHtml.replace(
  /(<h3 id="[^"]*">(?:(?!<\/h3>)[\s\S])*<\/h3>\n)(<figure class="diagram landscape"[\s\S]*?<\/figure>\n?)(<p>(?:(?!<\/p>)[\s\S])*<\/p>\n)/g,
  '<section class="landscape-section">$1$2$3</section>\n'
);

// ------------------------------------------------------------------- HTML

const css = fs.readFileSync(path.join(here, "doc-style.css"), "utf8");

function tocHtml(pages) {
  return headings
    .map(
      (h) =>
        `<li class="toc-${h.depth}"><a href="#${h.id}"><span class="t">${esc(h.text)}</span>` +
        `<span class="dots"></span><span class="p">${pages?.[h.id] ?? "–"}</span></a></li>`
    )
    .join("\n");
}

function pageHtml(pages) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ShipFlow — Technical Documentation</title>
<style>${css}</style></head><body>
<section class="cover">
  <div class="cover-band">
    <div class="eyebrow">Technical documentation · architecture · engineering decisions</div>
    <h1>ShipFlow</h1>
    <p class="subtitle">CLI-First, Self-Hosted CI/CD and Release Automation Platform</p>
  </div>
  <div class="cover-body">
    <p class="lead">From the original implementation to the hardened design: what was built, what was wrong, what changed and why, how it works internally, and how it compares with existing platforms.</p>
    <table class="meta">
      <tr><th>Document date</th><td>2026-10-10</td></tr>
      <tr><th>Repository state</th><td>Last commit <code>3709133</code> plus uncommitted engineering work (nothing committed or pushed)</td></tr>
      <tr><th>Deployment status</th><td>Verified local demo (<code>http://localhost:8081/</code> is a local address). Not deployed on any public server.</td></tr>
      <tr><th>Verification</th><td>51 unit tests and 13 end-to-end scenarios passing on the current checkout (Chapter 10)</td></tr>
      <tr><th>Author's note</th><td>Source of truth is the code; every claim is tagged as verified, tested, reported, inferred or future.</td></tr>
    </table>
  </div>
</section>
<section class="toc"><h2 class="toc-title">Contents</h2><ol>${tocHtml(pages)}</ol></section>
<main>${bodyHtml}</main>
</body></html>`;
}

// ------------------------------------------------------------------- render

const mermaidConfig = {
  startOnLoad: false,
  theme: "base",
  securityLevel: "loose",
  fontFamily: "Lato, 'DejaVu Sans', sans-serif",
  themeVariables: {
    primaryColor: "#e3f2fd",
    primaryBorderColor: "#1565c0",
    primaryTextColor: "#0d2a4a",
    lineColor: "#546e7a",
    secondaryColor: "#f1f8e9",
    tertiaryColor: "#fafafa",
    fontSize: "15px",
    noteBkgColor: "#fff8e1",
    noteBorderColor: "#f9a825",
    actorBkg: "#e3f2fd",
    actorBorder: "#1565c0",
    signalColor: "#37474f",
  },
  flowchart: { htmlLabels: true, useMaxWidth: true, curve: "basis", nodeSpacing: 28, rankSpacing: 38 },
  sequence: { useMaxWidth: true, wrap: true, width: 96, actorMargin: 14, messageFontSize: 14, noteFontSize: 14, mirrorActors: false },
  er: { useMaxWidth: true },
  state: { useMaxWidth: true },
};

async function render(pages, { writeSvg }) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 1400 });
    await page.setContent(pageHtml(pages), { waitUntil: "load" });
    await page.addScriptTag({ path: mermaidPath });

    const errors = await page.evaluate(async (config) => {
      window.mermaid.initialize(config);
      const failures = [];
      const nodes = [...document.querySelectorAll("pre.mermaid")];

      for (const node of nodes) {
        try {
          await window.mermaid.run({ nodes: [node] });
        } catch (error) {
          failures.push(`${node.dataset.index}: ${String(error.message || error).slice(0, 300)}`);
        }
      }
      return failures;
    }, mermaidConfig);

    if (errors.length) {
      throw new Error(`Mermaid errors:\n${errors.join("\n")}`);
    }

    if (writeSvg) {
      const svgs = await page.evaluate(() =>
        [...document.querySelectorAll("figure.diagram svg")].map((s) => s.outerHTML)
      );
      svgs.forEach((svg, i) =>
        fs.writeFileSync(
          path.join(DIAGRAMS, `${diagrams[i].slug}.svg`),
          `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`
        )
      );
    }

    await page.evaluate(() => document.fonts.ready);
    await page.pdf({
      path: OUT,
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      outline: true,
      tagged: true,
    });
  } finally {
    await browser.close();
  }
}

function python(mode, payload) {
  if (!fs.existsSync(PAGE_INDEX)) return null;

  try {
    const out = execFileSync(PYTHON, ["-I", PAGE_INDEX, mode, OUT], {
      input: JSON.stringify(payload),
      encoding: "utf8",
    });
    return out.trim() ? JSON.parse(out) : {};
  } catch (error) {
    console.warn(`PyMuPDF step "${mode}" skipped:`, String(error.message).split("\n")[0]);
    return null;
  }
}

await render(null, { writeSvg: true });
const pages = python("index", headings.map((h) => ({ id: h.id, text: h.text, depth: h.depth })));

if (pages) {
  await render(pages, { writeSvg: false });
  // Running header and footer are drawn afterwards so the cover stays clean.
  python("finish", {
    chapters: headings
      .filter((h) => h.depth === 2 && pages[h.id])
      .map((h) => ({ text: h.text, page: pages[h.id] })),
  });
}

console.log(`Wrote ${path.relative(process.cwd(), OUT)} and ${diagrams.length} diagrams in docs/diagrams/`);
