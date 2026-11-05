"""Anti-constant tests for derived metrics.

The bug that motivated this suite: js_word_diff_pct always returned 0.0%, so a
JavaScript-heavy site was reported as "JS does not affect this page". No test
could catch it, because nothing asserted that a derived metric is *able to vary*.

Rule applied here: every derived metric gets two assertions.
  - it CHANGES when the underlying data changes (no silent constants)
  - it does NOT change when the data is the same (no random noise)

Run:  .venv\\Scripts\\python.exe -m unittest discover -s tests -v
"""
import re
import sys
import unittest
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analysis import (link_score, minhash, near_duplicates, pixel_width,
                      semantic_index, semantic_pairs)
from crawler import (Crawler, CrawlConfig, clean_text, validate_html, _ngrams,
                     flesch)

def _crawler(**kw):
    return Crawler(CrawlConfig(start_url="https://exemplo.test/", auto_analyse=False, **kw))


def _page(html):
    """Parse one in-memory page through the real _parse pipeline."""
    from bs4 import BeautifulSoup
    c = _crawler()
    rec = Crawler._blank("https://exemplo.test/", 0)
    c._parse(rec, BeautifulSoup(html, "lxml"), html, 0)
    return c, rec, rec


# ---------------------------------------------------------------- anti-constant
class TestPixelWidth(unittest.TestCase):
    def test_varies_with_text(self):
        self.assertNotEqual(pixel_width("Curto", 20), pixel_width("Um titulo bem mais longo", 20))

    def test_varies_with_font_size(self):
        self.assertNotEqual(pixel_width("Titulo", 14), pixel_width("Titulo", 20))

    def test_stable_for_same_input(self):
        self.assertEqual(pixel_width("Titulo", 20), pixel_width("Titulo", 20))

    def test_empty_is_zero(self):
        self.assertEqual(pixel_width("", 20), 0)


class TestMinHash(unittest.TestCase):
    def test_different_text_gives_different_signature(self):
        self.assertFalse((minhash("conteudo diferente sobre gatos e cachorros e passaros") ==
                          minhash("outro assunto distinto sobre carros e motos rapidas")).all())

    def test_identical_text_gives_identical_signature(self):
        t = "um texto de teste com bastante palavras para gerar shingles suficientes aqui"
        self.assertTrue((minhash(t) == minhash(t)).all())

    def test_too_short_returns_none(self):
        self.assertIsNone(minhash("a b"))

    def test_near_duplicates_finds_pair(self):
        base = " ".join(["palavra%d" % i for i in range(60)])
        items = [("https://a.test/", minhash(base)),
                 ("https://b.test/", minhash(base + " extra")),
                 ("https://c.test/", minhash(" ".join(["outro%d" % i for i in range(60)])))]
        res = near_duplicates(items, 90)
        self.assertIn("https://b.test/", dict(res.get("https://a.test/", [])))

    def test_near_duplicates_empty_when_all_distinct(self):
        items = [("https://a.test/", minhash(" ".join(["alfa%d" % i for i in range(60)]))),
                 ("https://b.test/", minhash(" ".join(["beta%d" % i for i in range(60)])))]
        self.assertEqual(near_duplicates(items, 90), {})


class TestLinkScore(unittest.TestCase):
    def test_more_inlinks_scores_higher(self):
        nodes = ["home", "a", "b", "c"]
        scores = link_score(nodes, [("home", "a"), ("home", "b"), ("home", "c"), ("a", "b")])
        self.assertGreater(scores["b"], scores["c"], "page with 2 inlinks should outrank one with 1")

    def test_scores_are_not_all_equal(self):
        scores = link_score(["h", "x", "y"], [("h", "x"), ("h", "y")])
        self.assertGreater(len(set(scores.values())), 1, "link_score returned a constant")
    def test_scales_between_0_and_100(self):
        scores = link_score(["a", "b", "c"], [("a", "b"), ("b", "c")])
        self.assertTrue(all(0 <= v <= 100 for v in scores.values()))

    def test_empty_graph(self):
        self.assertEqual(link_score([], []), {})


class TestSemantic(unittest.TestCase):
    def test_distinct_docs_not_perfectly_similar(self):
        idx = semantic_index(["gatos e cachorros domesticos", "carros e motos rapidas",
                              "receitas de bolo de chocolate", "futebol e esportes radicais"])
        pairs = semantic_pairs(idx["E"], 0.9)
        best = max(p[2] for p in pairs)
        self.assertLess(best, 0.999, "semantic similarity returned a constant")

    def test_identical_docs_are_similar(self):
        t = "texto identico sobre o mesmo assunto repetido varias vezes"
        idx = semantic_index([t, t, t])
        pairs = semantic_pairs(idx["E"], 0.5)
        self.assertTrue(all(p[2] > 0.99 for p in pairs))

    def test_index_shape(self):
        idx = semantic_index(["a b c d e", "f g h i j", "k l m n o"])
        self.assertEqual(len(idx["E"]), 3)


class TestFlesch(unittest.TestCase):
    def test_easy_and_hard_text_differ(self):
        easy = "Eu vi o gato. Ele comeu. O cao latiu. Nos fomos. " * 30
        hard = ("A implementacao sistematica da metodologia epistemologica "
                "contemporanea pressupoe consideracoes ontologicas complexas. ") * 30
        a, b = flesch(easy, "pt"), flesch(hard, "pt")
        self.assertIsNotNone(a)
        self.assertIsNotNone(b)
        self.assertNotEqual(a, b, "flesch returned a constant")
        self.assertGreater(a, b, "simple text should score higher than dense text")

    def test_short_text_returns_none(self):
        self.assertIsNone(flesch("curto", "pt"))


class TestCleanText(unittest.TestCase):
    def test_collapses_runs(self):
        self.assertEqual(clean_text("CEO -  A   Sua  Clinica"), "CEO - A Sua Clinica")

    def test_strips_edges(self):
        self.assertEqual(clean_text("   titulo   "), "titulo")

    def test_preserves_single_spaces(self):
        self.assertEqual(clean_text("a b c"), "a b c")

    def test_newlines_and_tabs(self):
        self.assertEqual(clean_text("a\n\tb\r\nc"), "a b c")


class TestNgrams(unittest.TestCase):
    def test_counts_vary_by_text(self):
        a = _ngrams("gato come racao gato come racao", 2, False)
        b = _ngrams("cachorro late muito alto", 2, False)
        self.assertNotEqual(dict(a), dict(b))

    def test_known_bigram_counted(self):
        grams = _ngrams("gato come racao", 2, False)
        self.assertEqual(grams["gato come"], 1)


# ------------------------------------------------------- page-level extraction
class TestPageExtraction(unittest.TestCase):
    HTML = """<html lang="pt-BR"><head>
        <title>Um titulo de teste razoavel</title>
        <meta name="description" content="Uma descricao de teste qualquer.">
        <link rel="canonical" href="https://exemplo.test/">
    </head><body><h1>Cabecalho principal</h1>
        <p>%s</p>
        <img src="/a.png"><img src="/b.png" alt="b">
    </body></html>"""

    def test_title_extracted_and_cleaned(self):
        _, rec, _ = _page(self.HTML % ("palavra " * 40))
        self.assertEqual(rec["title"], "Um titulo de teste razoavel")
        self.assertEqual(rec["title"], clean_text(rec["title"]))

    def test_title_length_matches_value(self):
        _, rec, _ = _page(self.HTML % ("palavra " * 40))
        self.assertEqual(rec["title_len"], len(rec["title"]))

    def test_word_count_varies_with_content(self):
        _, short, _ = _page(self.HTML % ("palavra " * 10))
        _, long, _ = _page(self.HTML % ("palavra " * 200))
        self.assertNotEqual(short["word_count"], long["word_count"])
        self.assertGreater(long["word_count"], short["word_count"])

    def test_images_missing_alt_counted(self):
        _, rec, _ = _page(self.HTML % ("palavra " * 40))
        self.assertEqual(rec["images"], 2)
        self.assertEqual(rec["images_missing_alt"], 1)

    def test_canonical_matches_self_is_detected(self):
        _, rec, _ = _page(self.HTML % ("palavra " * 40))
        self.assertEqual(rec["canonical"], "https://exemplo.test/")

    def test_content_hash_varies(self):
        _, a, _ = _page(self.HTML % ("alfa " * 40))
        _, b, _ = _page(self.HTML % ("beta " * 40))
        self.assertNotEqual(a["content_hash"], b["content_hash"])

    def test_content_hash_stable(self):
        _, a, _ = _page(self.HTML % ("alfa " * 40))
        _, b, _ = _page(self.HTML % ("alfa " * 40))
        self.assertEqual(a["content_hash"], b["content_hash"])

    def test_h1_has_no_double_space(self):
        html = self.HTML.replace("Cabecalho principal", "Cabecalho  principal")
        _, rec, _ = _page(html % ("palavra " * 40))
        self.assertNotIn("  ", rec["h1_1"])

    def test_text_ratio_varies(self):
        dense = "<html><body><p>" + ("palavras " * 300) + "</p></body></html>"
        sparse = "<html><body>" + ("<div class='x'></div>" * 300) + "<p>oi</p></body></html>"
        _, a, _ = _page(dense)
        _, b, _ = _page(sparse)
        self.assertNotEqual(a["text_ratio"], b["text_ratio"])

    def test_noindex_detected(self):
        html = self.HTML.replace("</head>", '<meta name="robots" content="noindex"></head>')
        _, rec, _ = _page(html % ("palavra " * 40))
        self.assertIn("noindex", rec["meta_robots"].lower())


# --------------------------------------------------------------- js parity bug
class TestJsParity(unittest.TestCase):
    """Regression suite for the metric that silently returned 0.0%."""

    def _parity(self, raw_html, rendered_html):
        c = _crawler()
        rec = Crawler._blank("https://exemplo.test/", 0)
        from bs4 import BeautifulSoup
        from crawler import validate_html  # noqa: F401
        # rendered side first, exactly like _fetch_page does
        c._parse(rec, BeautifulSoup(rendered_html, "lxml"), rendered_html, 0)
        c._js_parity(rec, raw_html)
        return rec

    RAW = ("<html><body><nav>menu</nav><main><p>%s</p></main>"
           "<footer>rodape</footer></body></html>")

    def test_diff_is_nonzero_when_js_adds_content(self):
        raw = self.RAW % ("palavra " * 50)
        rendered = self.RAW % ("palavra " * 150)
        rec = self._parity(raw, rendered)
        self.assertGreater(rec["js_word_diff_pct"], 1.0,
                           "js_word_diff_pct stayed at 0 while JS tripled the content")

    def test_diff_is_zero_when_identical(self):
        same = self.RAW % ("palavra " * 50)
        rec = self._parity(same, same)
        self.assertEqual(rec["js_word_diff_pct"], 0)

    def test_raw_words_below_rendered_words(self):
        raw = self.RAW % ("palavra " * 50)
        rendered = self.RAW % ("palavra " * 150)
        rec = self._parity(raw, rendered)
        self.assertLess(rec["js_raw_words"], rec["word_count"])

    def test_title_change_detected(self):
        raw = "<html><head><title>Antigo</title></head><body><p>%s</p></body></html>" % ("x " * 40)
        rendered = "<html><head><title>Novo</title></head><body><p>%s</p></body></html>" % ("x " * 40)
        rec = self._parity(raw, rendered)
        self.assertTrue(rec["js_title_changed"])

    def test_title_not_flagged_when_same(self):
        same = "<html><head><title>Igual</title></head><body><p>%s</p></body></html>" % ("x " * 40)
        rec = self._parity(same, same)
        self.assertFalse(rec["js_title_changed"])

    def test_canonical_change_detected(self):
        raw = ('<html><head><link rel="canonical" href="https://exemplo.test/a"></head>'
               '<body><p>%s</p></body></html>') % ("x " * 40)
        rendered = ('<html><head><link rel="canonical" href="https://exemplo.test/b"></head>'
                    '<body><p>%s</p></body></html>') % ("x " * 40)
        rec = self._parity(raw, rendered)
        self.assertTrue(rec["js_canonical_changed"])


# ----------------------------------------------------------------- srcset bug
class TestImageSrcset(unittest.TestCase):
    HTML = """<html><body>
        <img src="/a-1000.png"
             srcset="/a-300.png 300w, /a-768.png 768w, /a-1000.png 1000w">
        <img src="/b.png" alt="sem srcset">
    </body></html>"""

    def test_srcset_variants_collected(self):
        c, rec, _ = _page(self.HTML)
        srcs = {r["src"] for r in c.image_refs}
        self.assertIn("https://exemplo.test/a-300.png", srcs)
        self.assertIn("https://exemplo.test/a-768.png", srcs)

    def test_srcset_can_be_disabled(self):
        from bs4 import BeautifulSoup
        c = _crawler(img_srcset=False)
        rec = Crawler._blank("https://exemplo.test/", 0)
        c._parse(rec, BeautifulSoup(self.HTML, "lxml"), self.HTML, 0)
        srcs = {r["src"] for r in c.image_refs}
        self.assertNotIn("https://exemplo.test/a-300.png", srcs)

    def test_default_is_enabled(self):
        self.assertTrue(CrawlConfig().img_srcset)


# ------------------------------------------------------------- html validation
class TestHtmlValidation(unittest.TestCase):
    def test_clean_document_has_no_defects(self):
        out = validate_html("<html><head><title>t</title></head><body><p>x</p></body></html>")
        self.assertFalse(out["val_missing_head"])
        self.assertFalse(out["val_missing_body"])

    def test_missing_head_detected(self):
        out = validate_html("<html><body><p>x</p></body></html>")
        self.assertTrue(out["val_missing_head"])

    def test_invalid_head_element_detected(self):
        out = validate_html("<html><head><div>x</div></head><body></body></html>")
        self.assertIn("div", out["val_invalid_head"])

    def test_valid_head_content_accepted(self):
        out = validate_html('<html><head><meta charset="utf-8"><title>t</title></head><body></body></html>')
        self.assertEqual(out["val_invalid_head"], "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
