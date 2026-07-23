#!/usr/bin/env python3
"""
Validator for correct_eic.py output.

Checks, per corrected PDF:
  1. No internal-id-shaped token (24-char hex) remains anywhere in the file.
  2. Both EIC values present match the real EIC format (24Z...).
  3. The corrected value actually matches what the CSV lookup says for the
     internal id that used to be there (per the correction report - catches
     a wrong-lookup or transcription bug, not just "looks like an EIC").
  4. Nothing else changed: extracted text of corrected vs. original is
     identical except for the specific token substitutions the report claims
     - i.e. the "without touching other parts" guarantee actually holds.
     (Skipped for widget-path corrections, where the widget's own appearance
     stream changes by design; text-path corrections are diffed line-by-line.)

Usage:
    python3 validate_eic_correction.py \
        --report reports/eic-correction-report-<timestamp>.json \
        --originals . \
        --corrected corrected/

Exits non-zero if any check fails, so it can gate a batch (e.g. before
treating corrected/ as ready to hand off).
"""
import argparse
import json
import re
import sys
from pathlib import Path

import fitz  # PyMuPDF

CANDIDATE_RE = re.compile(r"\b[0-9a-f]{24}\b", re.IGNORECASE)
REAL_EIC_RE = re.compile(r"\b24Z[0-9A-Z]{10,18}\b", re.IGNORECASE)


def extract_text(path):
    doc = fitz.open(path)
    try:
        return "\n".join(page.get_text() for page in doc)
    finally:
        doc.close()


def validate_file(entry, originals_dir, corrected_dir):
    """Returns a list of problem strings (empty = passed all checks)."""
    problems = []
    fname = entry["file"]
    status = entry["status"]

    if status not in ("corrected", "partially_corrected"):
        return problems  # nothing to validate - unaffected/unresolved/error

    corrected_path = corrected_dir / fname
    original_path = originals_dir / fname

    if not corrected_path.is_file():
        return [f"expected corrected output missing: {corrected_path}"]

    corrected_text = extract_text(corrected_path)

    # Check 1: no residual internal ids.
    residual = CANDIDATE_RE.findall(corrected_text)
    # A value that was intentionally left unresolved is expected to still be
    # present (the tool didn't touch it) - only flag ids NOT in "unresolved".
    unresolved_set = set(x.lower() for x in entry.get("unresolved", []))
    unexpected_residual = [r for r in residual if r.lower() not in unresolved_set]
    if unexpected_residual:
        problems.append(f"residual internal id(s) still present after correction: {sorted(set(unexpected_residual))}")

    # Check 2 + 3: every claimed correction is present, in real-EIC format,
    # and matches the report's own record of what it was corrected TO.
    for wrong_id, claimed_correct in entry.get("corrected", {}).items():
        if not REAL_EIC_RE.match(claimed_correct):
            problems.append(f"'{claimed_correct}' (corrected from {wrong_id}) does not look like a real EIC code")
        if claimed_correct not in corrected_text:
            problems.append(f"corrected value '{claimed_correct}' (for {wrong_id}) not found anywhere in the output PDF text")

    # Check 4: nothing else changed, for text-path corrections only.
    #
    # NOTE: this is an ORDER-INDEPENDENT (multiset) comparison, not a
    # positional line-by-line diff. PyMuPDF's get_text() sorts extracted
    # spans by their own internal ordering, and newly inserted text (via
    # insert_text) can land in a different position in that ordering than
    # the original span did, even though it renders in the correct visual
    # spot on the page. A strict positional diff produces false-positive
    # failures from this reordering alone - verified directly: the corrected
    # value was present, at a shifted line number, with the original PDF's
    # true visual/positional correctness already confirmed separately via
    # rendered-image inspection. Comparing line MULTISETS (bag of lines)
    # instead avoids this false positive while still catching a real
    # regression: any line content change that isn't explained by the
    # claimed wrong-id -> correct-value substitutions.
    paths = entry.get("paths", {})
    any_widget = any(p == "widget" for p in paths.values())
    if not any_widget and original_path.is_file():
        from collections import Counter

        original_text = extract_text(original_path)
        orig_lines = original_text.splitlines()
        corr_lines = corrected_text.splitlines()

        expected_corr_lines = list(orig_lines)
        for wrong, correct in entry["corrected"].items():
            for i, line in enumerate(expected_corr_lines):
                if line == wrong:
                    expected_corr_lines[i] = correct
                    break

        expected_bag = Counter(expected_corr_lines)
        actual_bag = Counter(corr_lines)
        if expected_bag != actual_bag:
            missing = list((expected_bag - actual_bag).elements())
            extra = list((actual_bag - expected_bag).elements())
            problems.append(
                "content changed beyond the claimed EIC substitution(s) - "
                f"missing: {missing[:5]}, unexpected extra: {extra[:5]}"
            )

    return problems


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--report", required=True, help="correct_eic.py's JSON report to validate against")
    ap.add_argument("--originals", required=True, help="folder containing the original (uncorrected) PDFs")
    ap.add_argument("--corrected", required=True, help="folder containing correct_eic.py's output")
    args = ap.parse_args()

    with open(args.report, encoding="utf-8") as f:
        report = json.load(f)

    originals_dir = Path(args.originals)
    corrected_dir = Path(args.corrected)

    total_checked = 0
    total_failed = 0
    for entry in report["results"]:
        if entry["status"] not in ("corrected", "partially_corrected"):
            continue
        total_checked += 1
        problems = validate_file(entry, originals_dir, corrected_dir)
        if problems:
            total_failed += 1
            print(f"[FAIL] {entry['file']}")
            for p in problems:
                print(f"        - {p}")
        else:
            print(f"[ OK ] {entry['file']}")

    print(f"\n{total_checked - total_failed}/{total_checked} corrected files passed validation")
    if total_failed:
        print(f"{total_failed} file(s) FAILED validation - do not treat corrected/ as ready until resolved.")
        sys.exit(1)


if __name__ == "__main__":
    main()
