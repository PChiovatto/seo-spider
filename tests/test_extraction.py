"""Inspetor da Extração Visual: o documento servido ao iframe e o contador de correspondências.

O contrato testado aqui é o que torna o inspetor seguro e útil:
  - a página chega SEM scripts (nada do site executa dentro do app)
  - o CSS do próprio site viaja junto (senão o preview fica sem estilo)
  - CSS, XPath e regex contam o que realmente existe na página, e mudam quando a página muda
  - seletor inválido devolve erro em vez de explodir

Nada sai da máquina: o HTML é montado no teste.
"""
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import extraction
from fastapi import FastAPI
from fastapi.testclient import TestClient

URL = "https://exemplo.test/pagina"

HTML = """<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<title>Titulo da pagina de teste</title>
<link rel="stylesheet" href="https://exemplo.test/wp-content/a.css">
<style>.hero{color:#123456}</style>
<script>window.tracker = {id: 1};</script>
<script src="https://exemplo.test/app.js"></script>
</head><body>
<div class="hero"><h1>Cabecalho principal</h1></div>
<a href="https://exemplo.test/contato">Contato</a>
<a href="https://exemplo.test/blog">Blog</a>
<img src="/a.png">
<noscript><img height="1" width="1" src="https://www.googletagmanager.com/ns.html?id=GTM-1"></noscript>
</body></html>"""


class _FakeCrawler:
    """Mesma interface de Crawler.source(url) que o app usa."""
    def __init__(self, html):
        self.html = html

    def source(self, url, rendered=False):
        return self.html if url == URL else None


def _client(html=None, url_known=True):
    app = FastAPI()
    state = {"crawler": _FakeCrawler(html if html is not None else HTML) if url_known else None}
    extraction.register(app, state)
    return TestClient(app)


class TestInspectorDocument(unittest.TestCase):
    def test_served_page_has_no_scripts(self):
        r = _client().get("/api/extraction/source", params={"url": URL})
        self.assertEqual(r.status_code, 200)
        body = r.text.lower()
        self.assertNotIn("<script", body)
        self.assertNotIn("window.tracker", body)

    def test_site_css_is_kept(self):
        body = _client().get("/api/extraction/source", params={"url": URL}).text
        self.assertIn(".hero{color:#123456}", body, "bloco <style> do site perdido")
        self.assertIn("wp-content/a.css", body, "stylesheet do site perdido")

    def test_csp_meta_is_dropped(self):
        body = _client().get("/api/extraction/source", params={"url": URL}).text
        self.assertNotIn("Content-Security-Policy", body)

    def test_page_markup_present(self):
        body = _client().get("/api/extraction/source", params={"url": URL}).text
        self.assertIn("<h1>Cabecalho principal</h1>", body)
        self.assertIn('href="https://exemplo.test/contato"', body)

    def test_unknown_url_is_404(self):
        r = _client().get("/api/extraction/source", params={"url": "https://outro.test/"})
        self.assertEqual(r.status_code, 404)

    def test_no_crawl_is_404(self):
        r = _client(url_known=False).get("/api/extraction/source", params={"url": URL})
        self.assertEqual(r.status_code, 404)

    def test_inline_script_in_noscript_is_removed(self):
        raw = HTML.replace("<noscript>", "<noscript><script>alert(1)</script>")
        body = _client(raw).get("/api/extraction/source", params={"url": URL}).text
        self.assertNotIn("alert(1)", body)


class TestMatchCounter(unittest.TestCase):
    def check(self, kind, expr):
        return _client().get("/api/extraction/check", params={"url": URL, "type": kind, "expr": expr}).json()

    def test_css_counts(self):
        self.assertEqual(self.check("css", "h1")["count"], 1)
        self.assertEqual(self.check("css", "a[href]")["count"], 2)
        self.assertEqual(self.check("css", ".hero h1")["count"], 1)
        self.assertEqual(self.check("css", ".inexistente")["count"], 0)

    def test_css_count_varies_with_page(self):
        other = _client(HTML.replace("<h1>Cabecalho principal</h1>", "<h1>a</h1><h1>b</h1>"))
        r = other.get("/api/extraction/check", params={"url": URL, "type": "css", "expr": "h1"})
        self.assertEqual(r.json()["count"], 2)

    def test_css_sample_shows_text(self):
        out = self.check("css", "h1")
        self.assertIn("Cabecalho principal", out["sample"])

    def test_xpath_counts(self):
        self.assertEqual(self.check("xpath", "//h1")["count"], 1)
        self.assertEqual(self.check("xpath", "//a[@href]")["count"], 2)

    def test_xpath_text_of_element(self):
        self.assertIn("Cabecalho principal", self.check("xpath", "//h1")["sample"])

    def test_regex_counts(self):
        self.assertEqual(self.check("regex", "<title>(.*?)</title>")["count"], 1)
        self.assertEqual(self.check("regex", "exemplo\\.test/contato")["count"], 1)

    def test_regex_invalid_returns_error(self):
        out = self.check("regex", "(sem fechar")
        self.assertEqual(out["count"], 0)
        self.assertIn("Regex", out["error"])

    def test_css_invalid_returns_error(self):
        out = self.check("css", "::::")
        self.assertEqual(out["count"], 0)
        self.assertIn("inválido", out["error"])

    def test_empty_expression_is_zero(self):
        self.assertEqual(self.check("css", "   ")["count"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
