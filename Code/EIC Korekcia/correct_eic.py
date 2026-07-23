#!/usr/bin/env python3
"""
EIC internal-ID correction tool for signed producer PDFs.

Background: wattiva-backend's DocumentSigningMapper.resolveEicCode() should
resolve a location's internal Mongo _id reference into its real EIC code
before sending it to DocuSeal, but a previously-deployed version of the
backend predates that fix. As a result, some already-signed "Cestne
vyhlasenie" (producer declaration) PDFs show the raw internal id (a 24-char
hex ObjectId) instead of the real EIC code (format 24Z..., the same pattern
this repo's own EDC_bot.spec.ts already looks for: /24Z[0-9A-Z]{10,18}/gi).
That means EDC_bot.spec.ts can't read a usable EIC out of these PDFs, and the
affected producer fails or gets skipped at the OKTE registration step.

See README.md in this folder for the full story (root cause, the two write
paths, worked example) before running this for real.

This script:
  1. Scans a folder of signed PDFs.
  2. For each, finds every internal-id-shaped token (24-char hex).
  3. Looks each up in an EIC-mapping export (locations_export.csv or
     location_eics.csv - schema auto-detected, see load_eic_lookup) to get
     the real EIC code.
  4. If found: writes the real EIC into the PDF at the same visual position.
     Two paths, chosen automatically per value:
       - text path:   redact the flattened page-text region and re-insert.
       - widget path: the value is a live AcroForm field widget, so set the
         widget's field value and regenerate its appearance. (Redacting the
         page content stream alone would NOT fix a widget: the /AP appearance
         and /V value would keep the wrong id and the render would garble.)
     Both are reported per file so the operator can see which path each file
     took. Saved as a NEW file under <output>/ - the original signed PDF is
     never modified.
  5. If not found in the mapping export: the file is left untouched and
     flagged in the report for manual lookup.
  6. Writes a report (JSON + TXT, mirroring this repo's own
     reports/report-*.json/.txt convention) summarizing what happened to
     every file.

Usage:
    python3 correct_eic.py --input <folder> --csv locations_export.csv --output corrected/
    python3 correct_eic.py --input <folder> --csv locations_export.csv --output corrected/ --dry-run

--dry-run (or DRY_RUN=1, matching this repo's own EDC_bot.spec.ts /
EDC_agreg.bot.spec.ts env convention) previews what would change without
writing any corrected PDFs or report files.

Real customer PII moves through this script - keep --input/--output/--csv
inside a folder this repo's .gitignore already excludes (e.g. downloads/,
reports/, or any *.csv) and never point --output at anything tracked by git.

IMPORTANT (see README "Step 0.5"): the safety of the two write paths differs,
and the whole-page candidate regex has only been verified against the
"Cestne vyhlasenie" template. Before running on a NEW document type (e.g. a
Zmluva), confirm how it renders EIC values (flattened text vs. form widget)
and that no unrelated 24-hex token can appear on its pages.
"""
import argparse
import csv
import json
import os
import re
import sys
import traceback
from datetime import datetime
from pathlib import Path

import fitz  # PyMuPDF

INTERNAL_ID_RE = re.compile(r"^[0-9a-f]{24}$", re.IGNORECASE)
REAL_EIC_RE = re.compile(r"^24Z[0-9A-Z]{10,18}$", re.IGNORECASE)
CANDIDATE_RE = re.compile(r"\b[0-9a-f]{24}\b", re.IGNORECASE)


def find_candidate_ids(page_text):
    """Return every distinct internal-id-shaped token found on the page.

    NOTE: this is whole-page scope. Verified safe (0 or 2 matches, no false
    positives) for the "Cestne vyhlasenie" template only. UNVERIFIED for
    other document types (e.g. a Zmluva) - re-check before running there.
    """
    return sorted(set(m.group(0) for m in CANDIDATE_RE.finditer(page_text)))


def load_eic_lookup(csv_path):
    """Build a dict: internal_id (lowercase) -> real EIC code.

    Supports two export schemas seen in practice, auto-detected from the
    header (both map an internal Mongo _id to a real EIC code, just shaped
    differently):

    - "wide" (e.g. locations_export.csv): one row per location, with paired
      columns eic_import_id/eic_import (consumption) and
      eic_export_id/eic_export (delivery).
    - "long" (e.g. location_eics.csv): one row per EIC document, with
      eic_document_id -> eic_code directly (an eic_direction column
      distinguishes consumer/producer, but both feed the same combined
      lookup - direction doesn't matter for this purpose).
    """
    lookup = {}
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = set(reader.fieldnames or [])

        if "eic_document_id" in fieldnames and "eic_code" in fieldnames:
            for row in reader:
                rid = (row.get("eic_document_id") or "").strip()
                code = (row.get("eic_code") or "").strip()
                if rid and code and REAL_EIC_RE.match(code):
                    lookup[rid.lower()] = code
        else:
            for row in reader:
                for id_col, code_col in (("eic_import_id", "eic_import"), ("eic_export_id", "eic_export")):
                    rid = (row.get(id_col) or "").strip()
                    code = (row.get(code_col) or "").strip()
                    if rid and code and REAL_EIC_RE.match(code):
                        lookup[rid.lower()] = code
    return lookup


def _find_overlapping_widget(widgets, cand, rects):
    """Return a widget backing this candidate value, or None (plain text path).

    A widget backs the value if its field value contains the token, or (as a
    fallback) its rect overlaps one of the search_for rects. A degenerate
    (empty/infinite) widget rect - e.g. an invisible Signature field - never
    counts as an overlap.
    """
    cl = cand.lower()
    for w in widgets:
        fv = w.field_value
        if isinstance(fv, str) and cl in fv.lower():
            return w
    for w in widgets:
        wr = w.rect
        if wr.is_empty or wr.is_infinite:
            continue
        for r in rects:
            if (fitz.Rect(r) & wr).get_area() > 0:
                return w
    return None


def _span_size_at(text_dict, rect, default=11.0):
    """Best-effort original font size for the glyph run at `rect`."""
    for block in text_dict.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                sx0, _sy0, _sx1, sy1 = span["bbox"]
                if abs(sx0 - rect.x0) < 2 and abs(sy1 - rect.y1) < 2:
                    return span.get("size", default)
    return default


def correct_pdf(src_path, lookup, output_dir, dry_run=False):
    """Process one PDF. Returns a result dict for the report.

    On the write path, guarantees the document handle is closed even on error.
    """
    result = {
        "file": src_path.name,
        "status": "unaffected",  # unaffected | corrected | partially_corrected | unresolved | error
        "candidates_found": [],
        "corrected": {},
        "unresolved": [],
        "paths": {},  # candidate -> "text" | "widget"
    }

    doc = None
    try:
        doc = fitz.open(src_path)
        all_candidates = set()
        for page in doc:
            all_candidates.update(find_candidate_ids(page.get_text()))
            # Also seed from widget field values directly: page.get_text() reads
            # the content stream, not AcroForm appearance streams, so a wrong id
            # living ONLY inside a widget (no flattened-text echo) would
            # otherwise never be found at all, and the file would be silently
            # reported "unaffected" even though it's wrong.
            for widget in (page.widgets() or []):
                fv = widget.field_value
                if isinstance(fv, str):
                    all_candidates.update(find_candidate_ids(fv))

        if not all_candidates:
            return result

        all_candidates = sorted(all_candidates)  # deterministic insertion order
        result["candidates_found"] = list(all_candidates)

        # Plan replacements per page, classifying each into text vs widget path.
        text_reps_by_page = []   # (pno, [(rect, correct, size), ...])
        widget_reps_by_page = []  # (pno, [(widget, cand, correct), ...])
        unresolved = []

        for pno, page in enumerate(doc):
            widgets = list(page.widgets() or [])
            text_dict = page.get_text("dict")
            page_text_reps = []
            page_widget_reps = []
            for cand in all_candidates:
                rects = page.search_for(cand)
                widget = _find_overlapping_widget(widgets, cand, rects)
                if not rects and widget is None:
                    continue
                correct = lookup.get(cand.lower())
                if not correct:
                    if rects or widget is not None:
                        unresolved.append(cand)
                    continue
                result["corrected"][cand] = correct
                if widget is not None:
                    page_widget_reps.append((widget, cand, correct))
                    # "widget" always wins across pages/occurrences: it's the
                    # stricter classification (the validator relies on it to
                    # decide whether its text-diff check applies), so a later
                    # page's plain-text occurrence must never downgrade it.
                    result["paths"][cand] = "widget"
                    # A widget value can ALSO be echoed as flattened text; redact
                    # any such text rects that don't sit on the widget itself.
                    for r in rects:
                        if (fitz.Rect(r) & widget.rect).get_area() <= 0:
                            page_text_reps.append((r, correct, _span_size_at(text_dict, r)))
                else:
                    for r in rects:
                        page_text_reps.append((r, correct, _span_size_at(text_dict, r)))
                    result["paths"].setdefault(cand, "text")
            if page_text_reps:
                text_reps_by_page.append((pno, page_text_reps))
            if page_widget_reps:
                widget_reps_by_page.append((pno, page_widget_reps))

        result["unresolved"] = sorted(set(unresolved) - set(result["corrected"].keys()))

        if not result["corrected"]:
            result["status"] = "unresolved" if result["unresolved"] else "unaffected"
            return result

        if not dry_run:
            for pno, page_reps in text_reps_by_page:
                page = doc[pno]
                for r, _correct, _size in page_reps:
                    page.add_redact_annot(r, fill=(1, 1, 1))
                page.apply_redactions()
                for r, correct, size in page_reps:
                    x = r.x0
                    y = r.y1 - (size * 0.27)  # approximate descender offset
                    page.insert_text((x, y), correct, fontsize=size, color=(0, 0, 0), fontname="helv")

            for pno, page_reps in widget_reps_by_page:
                for widget, cand, correct in page_reps:
                    fv = widget.field_value if isinstance(widget.field_value, str) else ""
                    # _find_overlapping_widget matched `cand` case-insensitively,
                    # so the replace must be too - a plain str.replace() here
                    # would silently no-op on a case mismatch (e.g. the field
                    # value stores the hex id uppercased) while the file still
                    # gets reported "corrected".
                    pattern = re.compile(re.escape(cand), re.IGNORECASE)
                    widget.field_value = pattern.sub(correct, fv) if pattern.search(fv) else correct
                    widget.update()

            output_dir.mkdir(parents=True, exist_ok=True)
            out_path = output_dir / src_path.name
            doc.save(out_path, incremental=False)

        if result["unresolved"] and result["corrected"]:
            result["status"] = "partially_corrected"
        else:
            result["status"] = "corrected"
        return result
    except Exception:
        result["status"] = "error"
        result["error"] = traceback.format_exc()
        return result
    finally:
        if doc is not None:
            doc.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, help="Folder of signed PDFs to scan")
    ap.add_argument("--csv", required=True, help="EIC-mapping export path (internal-id -> real EIC lookup)")
    ap.add_argument("--output", required=True, help="Folder to write corrected copies into (originals never modified)")
    ap.add_argument("--report", default=None, help="Report file base name (default: eic-correction-report-<timestamp>)")
    ap.add_argument("--dry-run", action="store_true",
                    default=(os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes")),
                    help="Preview changes without writing corrected PDFs or report files (or set DRY_RUN=1)")
    args = ap.parse_args()

    input_dir = Path(args.input)
    output_dir = Path(args.output)
    csv_path = Path(args.csv)

    if not input_dir.is_dir():
        sys.exit(f"Input folder not found: {input_dir}")
    if not csv_path.is_file():
        sys.exit(f"CSV not found: {csv_path}")

    lookup = load_eic_lookup(csv_path)
    print(f"Loaded {len(lookup)} internal-id -> EIC mappings from {csv_path.name}")
    if args.dry_run:
        print("DRY RUN - no corrected PDFs or report files will be written.\n")

    pdfs = sorted(input_dir.glob("*.pdf"))
    if not pdfs:
        sys.exit(f"No PDFs found in {input_dir}")

    results = []
    for pdf in pdfs:
        r = correct_pdf(pdf, lookup, output_dir, dry_run=args.dry_run)
        results.append(r)
        paths = set(r.get("paths", {}).values())
        tag = f" [{'+'.join(sorted(paths))} path]" if paths else ""
        print(f"  [{r['status']:>20}] {pdf.name}{tag}")

    files_widget = sum(1 for r in results if "widget" in r.get("paths", {}).values())
    files_text = sum(1 for r in results if "text" in r.get("paths", {}).values())

    summary = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "dry_run": args.dry_run,
        "input_dir": str(input_dir),
        "csv": str(csv_path),
        "output_dir": str(output_dir),
        "total_scanned": len(results),
        "unaffected": sum(1 for r in results if r["status"] == "unaffected"),
        "corrected": sum(1 for r in results if r["status"] == "corrected"),
        "partially_corrected": sum(1 for r in results if r["status"] == "partially_corrected"),
        "unresolved": sum(1 for r in results if r["status"] == "unresolved"),
        "errors": sum(1 for r in results if r["status"] == "error"),
        "files_using_text_path": files_text,
        "files_using_widget_path": files_widget,
        "results": results,
    }

    if not args.dry_run:
        report_base = args.report or f"eic-correction-report-{datetime.now():%Y%m%d-%H%M%S}"
        reports_dir = input_dir.parent / "reports"
        reports_dir.mkdir(parents=True, exist_ok=True)

        json_path = reports_dir / f"{report_base}.json"
        txt_path = reports_dir / f"{report_base}.txt"
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)
        with open(txt_path, "w", encoding="utf-8") as f:
            _write_txt_report(f, summary, results)
        print(f"\nReport written: {json_path}")
        print(f"Report written: {txt_path}")

    print(f"\nSummary: {summary['corrected']} corrected, {summary['partially_corrected']} partial, "
          f"{summary['unresolved']} unresolved, {summary['unaffected']} already fine, {summary['errors']} errors "
          f"(of {summary['total_scanned']} scanned)")
    print(f"Write paths: {files_text} file(s) via text, {files_widget} file(s) via form widget")
    if files_widget:
        print("NOTE: widget-path files had at least one EIC in a live AcroForm field - "
              "verify these renders and field values before trusting them (see README Step 0.5).")


def _write_txt_report(f, summary, results):
    f.write(f"EIC correction report - {summary['generated_at']}\n")
    if summary["dry_run"]:
        f.write("(DRY RUN)\n")
    f.write(f"Input: {summary['input_dir']}\n")
    f.write(f"Total scanned: {summary['total_scanned']}\n")
    f.write(f"  unaffected (already correct):  {summary['unaffected']}\n")
    f.write(f"  corrected:                     {summary['corrected']}\n")
    f.write(f"  partially corrected:           {summary['partially_corrected']}\n")
    f.write(f"  unresolved (needs manual EIC): {summary['unresolved']}\n")
    f.write(f"  errors:                        {summary['errors']}\n")
    f.write(f"  files via text path:           {summary['files_using_text_path']}\n")
    f.write(f"  files via widget path:         {summary['files_using_widget_path']}\n\n")
    for r in results:
        if r["status"] in ("corrected", "partially_corrected"):
            f.write(f"[{r['status'].upper()}] {r['file']}\n")
            for wrong, correct in r["corrected"].items():
                f.write(f"    {wrong} -> {correct}  ({r.get('paths', {}).get(wrong, 'text')})\n")
            if r["unresolved"]:
                f.write(f"    UNRESOLVED: {', '.join(r['unresolved'])}\n")
        elif r["status"] == "unresolved":
            f.write(f"[UNRESOLVED] {r['file']}: {', '.join(r['unresolved'])}\n")
        elif r["status"] == "error":
            f.write(f"[ERROR] {r['file']}:\n{r.get('error', '')}\n")


if __name__ == "__main__":
    main()
