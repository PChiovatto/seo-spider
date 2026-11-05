"""Visual Extraction inspector support — serves the stored page to the inspector iframe and
answers "how many matches does this expression have?" for CSS / XPath / regex.

The page is sent as a static document: a sandboxed iframe (allow-same-origin, no scripts) can
read and measure the DOM while nothing from the site can run. Inline scripts are neutralised
so a preview never executes site code, even if a browser ignores the sandbox attribute.
"""
import re

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response

MAX_BYTES = 12 * 1024 * 1024
_INLINE_SCRIPT = re.compile(r"<script\b[^>]*>.*?</script\s*>", re.S | re.I)
_INNER_BODY = re.compile(r"<body\b[^>]*>(.*)</body\s*>", re.S | re.I)


def _neutralise(raw: str) -> str:
    """Drop <script> elements entirely (no console noise, nothing to execute) in both the head
    and the body, including the ones that inject page code into a noscript block."""
    return _INLINE_SCRIPT.sub("", raw)


def _static_html(raw: str) -> str:
    """The page is previewed as a static document: the inspector only needs text and attributes."""
    return _neutralise(raw)


_STYLE_BLOCK = re.compile(r"<style\b[^>]*>.*?</style\s*>", re.S | re.I)
_STYLESHEET = re.compile(r"<link\b[^>]*rel=[\"']?stylesheet[\"']?[^>]*>", re.S | re.I)


def _site_css(raw: str) -> str:
    """Inline <style> blocks plus same-origin stylesheets fetched while the crawl ran.

    The CSP meta tag and the <link> tags are gone from the preview, so the CSS has to travel
    with the document — otherwise the inspector shows an unstyled page."""
    blocks = _STYLE_BLOCK.findall(raw)
    for tag in _STYLESHEET.findall(raw):
        m = re.search(r"href=[\"']([^\"']+)[\"']", tag, re.I)
        if m:
            blocks.append('<link rel="stylesheet" href="%s">' % m.group(1))
    return "".join(blocks)


def _inspector_doc(raw: str) -> str:
    """Minimal document: the page's own markup (scripts stripped), no CSP meta that could
    block the inspector's highlight style, and a neutral base so nothing resolves on click."""
    body = _INNER_BODY.search(raw)
    markup = _neutralise(body.group(1) if body else raw)
    return ("<!doctype html><html><head><meta charset=\"utf-8\"><base target=\"_self\">"
            "<style>html{overflow:auto}body{margin:8px}</style>" + _site_css(raw) +
            "</head><body>" + markup.lstrip() + "</body></html>")


def register(app: FastAPI, state: dict) -> None:
    @app.get("/api/extraction/source")
    def extraction_source(url: str):
        c = state["crawler"]
        if not c:
            raise HTTPException(404, "Nenhum crawl iniciado")
        raw = c.source(url)
        if raw is None:
            raise HTTPException(404, "Código-fonte não disponível (ative 'Armazenar HTML' e rode o crawl)")
        body = _inspector_doc(raw)
        if len(body.encode("utf-8", "ignore")) > MAX_BYTES:
            raise HTTPException(413, "Página grande demais para o inspetor")
        return Response(body, media_type="text/html; charset=utf-8",
                        headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"})

    @app.get("/api/extraction/check")
    def extraction_check(url: str, expr: str, type: str = "css"):  # noqa: A002 - API field name
        c = state["crawler"]
        if not c:
            raise HTTPException(404, "Nenhum crawl iniciado")
        raw = c.source(url)
        if raw is None:
            raise HTTPException(404, "Código-fonte não disponível")
        if not expr.strip():
            return {"count": 0, "sample": ""}
        try:
            kind = type.lower()
            if kind == "regex":
                try:
                    rx = re.compile(expr)
                except re.error as e:
                    return {"count": 0, "sample": "", "error": f"Regex inválida: {e}"}
                hits = [m if isinstance(m, str) else next((g for g in m if g), "") for m in rx.findall(raw)]
            elif kind == "xpath":
                from lxml import html as lxml_html
                tree = lxml_html.fromstring(raw)
                hits = []
                for v in tree.xpath(expr):
                    if isinstance(v, str):
                        hits.append(v.strip())
                    else:
                        hits.append(" ".join(v.text_content().split()))
            else:
                from bs4 import BeautifulSoup
                soup = BeautifulSoup(raw, "lxml")
                try:
                    hits = [el.get_text(" ", strip=True) for el in soup.select(expr)]
                except Exception as e:  # invalid selector
                    return {"count": 0, "sample": "", "error": f"Seletor inválido: {e}"}
        except Exception as e:
            return {"count": 0, "sample": "", "error": f"{type(e).__name__}: {e}"[:300]}
        clean = [h for h in hits if h]
        return {"count": len(clean), "sample": " | ".join(clean[:6]), "total": len(hits)}
