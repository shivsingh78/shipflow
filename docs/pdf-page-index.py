"""PDF post-processing helpers for build-pdf.mjs (documentation tooling only).

  index  <pdf>   stdin: [{"id","text","depth"}]  ->  stdout: {"<id>": page}
                 Finds the page of each heading so the contents list can
                 show real page numbers.
  finish <pdf>   stdin: {"chapters": [{"text","page"}]}
                 Draws the running header and footer (page X of N) on every
                 page except the cover, then rewrites the PDF in place.

Requires PyMuPDF (`pip install pymupdf` in a throw-away virtualenv; it is not
an application dependency). Run with `python -I`.
"""
import json
import os
import sys

import pymupdf

mode, path = sys.argv[1], sys.argv[2]
payload = json.load(sys.stdin)
doc = pymupdf.open(path)


def find_page(text, start):
    probes = [text, text[:48]]
    for probe in probes:
        for number in range(start, len(doc)):
            if doc[number].search_for(probe):
                return number
    return None


if mode == "index":
    # The body starts at the first page containing the legend; the contents
    # list (which repeats every heading) is before it.
    body_start = find_page("How to read this document", 1) or 2
    result, cursor = {}, body_start

    for heading in payload:
        number = find_page(heading["text"], cursor)
        if number is not None:
            result[heading["id"]] = number + 1
            cursor = number

    print(json.dumps(result))

elif mode == "finish":
    chapters = payload["chapters"]
    total = len(doc)
    ink, accent = (0.47, 0.56, 0.61), (0.05, 0.16, 0.29)

    for index, page in enumerate(doc):
        if index == 0:
            continue

        number = index + 1
        width, height = page.rect.width, page.rect.height
        left, right = 16 * 2.835, width - 16 * 2.835

        current = "Contents"
        for chapter in chapters:
            if chapter["page"] <= number:
                current = chapter["text"]
        if len(current) > 70:
            current = current[:67] + "..."

        top = 11 * 2.835
        page.insert_text((left, top), "ShipFlow", fontsize=8, fontname="hebo", color=accent)
        page.insert_text((left + 38, top), "Technical Documentation", fontsize=8, fontname="helv", color=ink)
        page.insert_text(
            (right - pymupdf.get_text_length(current, "helv", 8), top),
            current, fontsize=8, fontname="helv", color=ink,
        )
        page.draw_line((left, top + 4), (right, top + 4), color=(0.81, 0.85, 0.86), width=0.5)

        bottom = height - 9 * 2.835
        page.insert_text((left, bottom), "Local demo - not a public deployment", fontsize=7.5, fontname="helv", color=ink)
        label = f"Page {number} of {total}"
        page.insert_text(
            (right - pymupdf.get_text_length(label, "helv", 7.5), bottom),
            label, fontsize=7.5, fontname="helv", color=ink,
        )

    temp = path + ".tmp"
    doc.save(temp, garbage=3, deflate=True)
    doc.close()
    os.replace(temp, path)
