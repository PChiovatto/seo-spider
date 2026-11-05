"""Tests for the WAF browser fallback.

Context: certapro.com answers 200 to curl and 403 to httpx from the same IP with
the same User-Agent — the firewall scores the TLS fingerprint. A real Chromium
passes. These tests pin the detection logic and the browser response shim, which
must keep the same interface the crawler already expects from httpx.
"""
import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from crawler import CrawlConfig
from waf_fallback import (BrowserResponse, WAF_HEADERS, _Headers, fetch_with_browser,
                          looks_like_waf_block)


class TestWafDetection(unittest.TestCase):
    def test_detects_cloudflare(self):
        self.assertTrue(looks_like_waf_block(403, {"CF-RAY": "abc123", "server": "cloudflare"}))

    def test_detects_datadome(self):
        self.assertTrue(looks_like_waf_block(403, {"x-datadome": "1"}))

    def test_detects_akamai(self):
        self.assertTrue(looks_like_waf_block(503, {"x-akamai-transformed": "9"}))

    def test_plain_403_is_not_waf(self):
        self.assertFalse(looks_like_waf_block(403, {"server": "nginx"}),
                         "a plain 403 must stay a 403, not trigger a browser retry")

    def test_404_is_never_waf(self):
        self.assertFalse(looks_like_waf_block(404, {"cf-ray": "abc"}))

    def test_200_is_never_waf(self):
        self.assertFalse(looks_like_waf_block(200, {"cf-ray": "abc"}))

    def test_header_match_is_case_insensitive(self):
        self.assertTrue(looks_like_waf_block(429, {"Cf-Ray": "x"}))

    def test_all_known_headers_trigger(self):
        for h in WAF_HEADERS:
            with self.subTest(header=h):
                self.assertTrue(looks_like_waf_block(403, {h: "1"}))


class TestHeadersShim(unittest.TestCase):
    def test_get_is_case_insensitive(self):
        h = _Headers({"cf-ray": "abc"})
        self.assertEqual(h.get("CF-RAY"), "abc")

    def test_get_list_returns_list(self):
        h = _Headers({"set-cookie": "a=1"})
        self.assertEqual(h.get_list("set-cookie"), ["a=1"])

    def test_get_list_missing_returns_empty(self):
        self.assertEqual(_Headers({}).get_list("set-cookie"), [])


class TestBrowserResponse(unittest.TestCase):
    def test_text_decodes_body(self):
        r = BrowserResponse(body="olá".encode("utf-8"))
        self.assertEqual(r.text, "olá")

    def test_is_redirect(self):
        self.assertTrue(BrowserResponse(status_code=301).is_redirect)
        self.assertFalse(BrowserResponse(status_code=200).is_redirect)

    def test_aiter_bytes_yields_whole_body(self):
        body = b"x" * 1000
        r = BrowserResponse(body=body)
        async def collect():
            return b"".join([c async for c in r.aiter_bytes(chunk_size=256)])
        self.assertEqual(asyncio.run(collect()), body)

    def test_aclose_is_awaitable_and_safe(self):
        asyncio.run(BrowserResponse().aclose())


class TestFallbackConfig(unittest.TestCase):
    def test_enabled_by_default(self):
        self.assertTrue(CrawlConfig().waf_fallback)

    def test_can_be_disabled(self):
        self.assertFalse(CrawlConfig(waf_fallback=False).waf_fallback)


class _FakePage:
    def __init__(self, status, html, headers, url='https://x.test/'):
        self._status, self._html, self._headers = status, html, headers
        self.closed = False
        self.url = url

    async def goto(self, url, **kw):
        class R:
            status = self._status
            status_text = "Forbidden"
            headers = self._headers
        return R()

    async def content(self):
        return self._html

    async def close(self):
        self.closed = True


class _FakeCtx:
    def __init__(self, page):
        self.page = page

    async def new_page(self):
        return self.page


class TestFetchWithBrowser(unittest.TestCase):
    def test_returns_browser_response(self):
        page = _FakePage(200, "<html><body>ok</body></html>", {"content-type": "text/html"})
        res = asyncio.run(fetch_with_browser(_FakeCtx(page), "https://x.test/"))
        self.assertEqual(res.status_code, 200)
        self.assertIn("ok", res.text)
        self.assertTrue(page.closed, "page must be closed even on success")

    def test_returns_none_on_browser_error(self):
        class Boom:
            async def new_page(self):
                raise RuntimeError("browser died")
        self.assertIsNone(asyncio.run(fetch_with_browser(Boom(), "https://x.test/")))

    def test_page_closed_on_error(self):
        page = _FakePage(200, "x", {})
        async def boom(url, **kw):
            raise RuntimeError("nav failed")
        page.goto = boom
        self.assertIsNone(asyncio.run(fetch_with_browser(_FakeCtx(page), "https://x.test/")))
        self.assertTrue(page.closed, "page must be closed when navigation fails")


if __name__ == "__main__":
    unittest.main(verbosity=2)
