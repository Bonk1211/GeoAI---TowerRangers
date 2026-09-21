"""
Render REPORT.md to a print-ready PDF using headless Chrome.

Usage:  pip install markdown
        python make_report_pdf.py

Writes report_print.html (intermediate) and
"AGAIF2026_BC1_CA3_MY-637_CHIN PEI KANG_Report.pdf".
"""
import os
import pathlib
import shutil
import subprocess
import sys

import markdown

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "REPORT.md"
HTML = HERE / "report_print.html"
PDF = HERE / "AGAIF2026_BC1_CA3_MY-637_CHIN PEI KANG_Report.pdf"

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "google-chrome",
    "chromium",
]

CSS = """
@page { size: A4; margin: 18mm 16mm; }
body {
  font: 10.5pt/1.55 "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  color: #1a1f2b;
  max-width: 100%;
}
h1 { font-size: 20pt; margin: 0 0 4pt; letter-spacing: -0.01em; }
h2 {
  font-size: 13pt;
  margin: 20pt 0 6pt;
  padding-bottom: 3pt;
  border-bottom: 1px solid #d7dde8;
  page-break-after: avoid;
}
h3 { font-size: 11pt; margin: 13pt 0 4pt; page-break-after: avoid; }
p, li { orphans: 3; widows: 3; }
hr { display: none; }
code {
  font-family: "Cascadia Mono", Consolas, monospace;
  font-size: 9pt;
  background: #f1f4f9;
  border-radius: 3px;
  padding: 1px 4px;
}
pre {
  background: #f6f8fb;
  border: 1px solid #dfe5ee;
  border-left: 3px solid #1d7f92;
  border-radius: 6px;
  padding: 9pt 11pt;
  overflow-x: auto;
  page-break-inside: avoid;
}
pre code { background: none; padding: 0; font-size: 8.6pt; line-height: 1.45; }
blockquote {
  margin: 8pt 0;
  padding: 7pt 12pt;
  background: #f6f8fb;
  border-left: 3px solid #94a2bc;
  color: #333b4d;
  font-style: italic;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin: 8pt 0 12pt;
  font-size: 9pt;
  page-break-inside: avoid;
}
th, td { border: 1px solid #dfe5ee; padding: 5pt 7pt; text-align: left; vertical-align: top; }
th { background: #eef2f8; font-weight: 600; }
img {
  max-width: 100%;
  border: 1px solid #dfe5ee;
  border-radius: 6px;
  page-break-inside: avoid;
}
a { color: #14607a; text-decoration: none; }
ul { padding-left: 16pt; }
h2#\\39 -screenshots + p { page-break-before: auto; }
"""


def find_chrome():
    for candidate in CHROME_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
        found = shutil.which(candidate)
        if found:
            return found
    return None


def main():
    body = markdown.markdown(
        SRC.read_text(encoding="utf-8"),
        extensions=["tables", "fenced_code", "sane_lists", "toc"],
    )
    HTML.write_text(
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<title>AGAIF2026 CA3 Report — CHIN PEI KANG</title>"
        f"<style>{CSS}</style></head><body>{body}</body></html>",
        encoding="utf-8",
    )

    chrome = find_chrome()
    if not chrome:
        print("Chrome/Edge not found — open report_print.html and print to PDF manually.")
        return 1

    subprocess.run(
        [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--no-pdf-header-footer",
            "--print-to-pdf=" + str(PDF),
            HTML.as_uri(),
        ],
        check=True,
    )
    print("wrote", PDF.name, round(PDF.stat().st_size / 1024), "KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
