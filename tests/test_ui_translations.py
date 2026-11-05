"""Local, opt-in UI translation audit (no network). Run: python -m tests.test_ui_translations -v

The UI translates Portuguese labels with t()/tf()/tt() and the table in static/i18n.json.
Some labels only appear inside those calls, so a typo on either side silently leaves the
interface in Portuguese while every other test still passes. This audit compares the
labels the UI actually passes to those helpers with the i18n table.
"""

import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import tr  # noqa: E402

STATIC = ROOT / "static"

# English keeps these spelled the same as Portuguese; anything else must translate.
SAME_IN_EN = {"Pixels", "Prompts", "Status", "Zoom", "Description", "Desktop", "Title", "Local (TF-IDF, offline)",
              "Crawl {{0}}%", "{{0}} cookies", "{{0}} inlinks", "~{{0}} URLs", "{{0}} (1024×768)", "{{0}} (411×731)"}


def _labels():
    """Every label passed to t(), tf() or tt() in the UI files, per file."""
    found = {}
    for f in list(STATIC.glob("*.js")) + list(STATIC.glob("*.html")):
        text = f.read_text(encoding="utf-8", errors="replace")
        labels = set(re.findall(r"\b(?:t|tf|tt)\(\s*'([^'\\]{2,90})'", text))
        labels |= set(re.findall(r'\b(?:t|tf|tt)\(\s*"([^"\\]{2,90})"', text))
        if labels:
            found[f.name] = labels
    return found


class TestUiTranslations(unittest.TestCase):
    def test_labels_used_by_the_ui_have_an_english_or_spanish_translation(self):
        missing = sorted(f"{lab} ({name})" for name, labels in _labels().items()
                         for lab in labels
                         if lab not in SAME_IN_EN and tr("en", lab) == lab and tr("es", lab) == lab)
        self.assertEqual(missing, [], f"labels left in Portuguese: {missing}")

    def test_i18n_file_has_no_duplicate_labels(self):
        rows = json.loads((STATIC / "i18n.json").read_bytes().decode("utf-8"))["strings"]
        keys = [r[0] for r in rows]
        dup = sorted({k for k in keys if keys.count(k) > 1})
        self.assertEqual(dup, [], f"duplicated labels: {dup}")

    def test_crawl_values_translate_in_every_language(self):
        values = json.loads((STATIC / "i18n.json").read_bytes().decode("utf-8"))["values"]
        for lang in ("pt", "en", "es"):
            self.assertTrue(values.get(lang, {}).get("Indexable"), f"missing Indexable in {lang}")
        self.assertNotEqual(values["pt"]["Indexable"], "Indexable", "pt must not repeat the English value")


if __name__ == "__main__":
    unittest.main(verbosity=2)
