# ShipFlow documentation

| File | What it is |
|---|---|
| `ShipFlow-Technical-Documentation.pdf` | The finished report (A4). |
| `ShipFlow-Technical-Documentation.md` | Editable source of the report. Diagrams are Mermaid blocks inside it. |
| `diagrams/*.mmd`, `diagrams/*.svg` | Each diagram's Mermaid source and its rendered SVG. Both are regenerated from the Markdown by the build script, so edit the Markdown, not these. |
| `build-pdf.mjs`, `doc-style.css`, `pdf-page-index.py` | The PDF build (documentation tooling only; not part of the application). |

## Rebuilding the PDF

The build tools live outside the repository so the application's dependencies are not touched.

```bash
mkdir -p /tmp/docbuild && cd /tmp/docbuild && npm init -y && npm install marked mermaid puppeteer-core
python3 -m venv /tmp/docvenv && /tmp/docvenv/bin/pip install pymupdf   # page numbers + running header/footer

cd <repo>
DOCBUILD_DIR=/tmp/docbuild CHROME_PATH=$(command -v google-chrome) \
DOC_PYTHON=/tmp/docvenv/bin/python node docs/build-pdf.mjs
```

Requirements: Node 18+, a Chrome/Chromium binary, and (optionally) PyMuPDF. Without PyMuPDF the PDF is still produced, but without page numbers in the contents list or the running header and footer.

Diagram options are `%%` comment lines at the top of a Mermaid block: `%% title:` (caption), `%% layout: landscape` (own landscape page), `%% maxheight: <mm>`.
