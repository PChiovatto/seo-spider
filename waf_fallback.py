"""Browser fallback for requests blocked by a WAF.

Some sites sit behind a firewall (Cloudflare, Akamai, DataDome…) that rejects
clients by their TLS fingerprint, not by IP or User-Agent. `httpx` uses the
httpcore stack, which is on those blocklists; a real Chromium is not. This was
measured against certapro.com: curl 200/5, httpx 403/5, same IP and UA,
same TLS version — only the fingerprint differed.

When a fetch comes back 403/429/503 with WAF headers, the crawler retries it
through Playwright and keeps the resulting HTML. BrowserResponse mirrors the
slice of the httpx.Response API that the crawler actually reads, so the rest of
the pipeline does not need to know which transport produced the page.
"""
from dataclasses import dataclass, field


WAF_STATUS = (403, 429, 503)
WAF_HEADERS = ("cf-ray", "cf-mitigated", "x-akamai-transformed", "akamai-grn",
               "x-sucuri-id", "x-iinfo", "x-datadome", "x-amzn-waf-action")


class _Headers(dict):
    """dict with the two httpx helpers the crawler uses: get_list() and get()."""

    def get(self, name, default=None):
        return super().get(str(name).lower(), default)

    def get_list(self, name, split_commas=False):
        v = super().get(str(name).lower())
        if v is None:
            return []
        return [x.strip() for x in v.split(",")] if split_commas else [v]


@dataclass
class BrowserResponse:
    """Minimal stand-in for an httpx.Response, filled from a real browser fetch."""
    status_code: int = 0
    reason_phrase: str = ""
    headers: object = field(default_factory=_Headers)
    body: bytes = b""
    url: str = ""
    charset_encoding: str = "utf-8"
    http_version: str = "HTTP/1.1"
    num_bytes_downloaded: int = 0
    _consumed: bool = False

    @property
    def text(self):
        try:
            return self.body.decode(self.charset_encoding or "utf-8", "replace")
        except LookupError:
            return self.body.decode("utf-8", "replace")

    @property
    def content(self):
        return self.body

    @property
    def is_redirect(self):
        return 300 <= self.status_code < 400

    async def aiter_bytes(self, chunk_size=65536):
        """The browser already has the full body; yield it in slices."""
        for i in range(0, len(self.body), chunk_size):
            yield self.body[i:i + chunk_size]
        self._consumed = True

    async def aclose(self):
        return None


def looks_like_waf_block(status, headers):
    """True when a response smells like a firewall rejection rather than a normal error."""
    if status not in WAF_STATUS:
        return False
    low = {str(k).lower() for k in headers}
    return any(h in low for h in WAF_HEADERS)


async def fetch_with_browser(ctx, url):
    """Load `url` in an existing Playwright context and return a BrowserResponse.

    Returns None when the browser itself fails, so the caller can fall back to
    reporting the original HTTP error.
    """
    page = None
    try:
        page = await ctx.new_page()
        resp = await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        html = await page.content()
        status = resp.status if resp else 0
        headers = _Headers({k.lower(): v for k, v in (resp.headers.items() if resp else [])})
        body = html.encode("utf-8", "replace")
        return BrowserResponse(
            status_code=status,
            reason_phrase=(resp.status_text if resp else "") or "",
            headers=headers,
            body=body,
            url=page.url,
            charset_encoding="utf-8",
            num_bytes_downloaded=len(body),
        )
    except Exception:
        return None
    finally:
        if page is not None:
            try:
                await page.close()
            except Exception:
                pass
    page = None
    try:
        page = await ctx.new_page()
        resp = await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        html = await page.content()
        status = resp.status if resp else 0
        headers = _Headers({k.lower(): v for k, v in (resp.headers.items() if resp else [])})
        body = html.encode("utf-8", "replace")
        return BrowserResponse(
            status_code=status,
            reason_phrase=(resp.status_text if resp else "") or "",
            headers=headers,
            body=body,
            url=page.url,
            charset_encoding="utf-8",
            num_bytes_downloaded=len(body),
        )
    except Exception:
        return None
    finally:
        if page is not None:
            try:
                await page.close()
            except Exception:
                pass
