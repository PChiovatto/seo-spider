"""Async SEO crawler: fetches internal pages (optionally rendering JavaScript),
extracts on-page SEO data, checks external links and images."""
import asyncio
import fnmatch
import gzip
import json
import hashlib
import re
from pathlib import Path
import time
import zlib
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urldefrag, urlencode, urljoin, urlparse, urlunparse
from xml.etree import ElementTree as ET

import httpx
from bs4 import BeautifulSoup, UnicodeDammit

from integrations import PAGE_FIELDS
from robots import Robots
from waf_fallback import fetch_with_browser, looks_like_waf_block
from analysis import (ANALYSIS_GROUPS, DEFAULT_PREFS, DEFAULT_SOFT404, DEFAULT_WEAK_ANCHORS, EXTRACT_RULES,
                      NONIDX_PREFIXES, PREFS, ISSUE_GROUPS, ISSUE_RULES, LANG_RE, SPELL_LANGS, _types, is_broken, schema_vocab, validate_entity, is_html, link_score, minhash,
                      misspelled, near_duplicates, pixel_width, semantic_embed, semantic_index, semantic_pairs,
                      speller, walk_jsonld)

SKIP_SCHEMES = ("mailto:", "tel:", "javascript:", "data:", "sms:", "whatsapp:", "ftp:")
# links a crawler cannot follow: href on a non-link tag, routing attributes, or a URL hidden in JavaScript
LINK_TAGS = {"a", "area", "link", "base"}
ROUTE_ATTRS = ("data-href", "data-url", "data-link", "routerlink", "ng-href", "to")
JS_URL_RE = re.compile(r"""(?:location(?:\.href)?\s*=|location\.(?:assign|replace)\(|window\.open\()\s*['"]([^'"]+)['"]""")
JS_PATH_RE = re.compile(r"""['"]((?:https?:)?/[^'"\s]*)['"]""")
HTML_TYPES = ("text/html", "application/xhtml+xml")
SEC_HEADERS = {
    "strict-transport-security": "HSTS",
    "x-content-type-options": "X-Content-Type-Options",
    "x-frame-options": "X-Frame-Options",
    "content-security-policy": "Content-Security-Policy",
    "referrer-policy": "Referrer-Policy",
}
MIXED_TAGS = {"img": "src", "script": "src", "iframe": "src", "video": "src", "audio": "src",
              "source": "src", "embed": "src", "link": "href"}
# page resources crawled besides <a> links and images: (tag, attribute, required rel or None)
RESOURCE_TAGS = [("script", "src", None), ("link", "href", "stylesheet"), ("link", "href", "preload"),
                 ("link", "href", "icon"), ("link", "href", "manifest"), ("video", "src", None),
                 ("audio", "src", None), ("source", "src", None), ("embed", "src", None),
                 ("object", "data", None), ("iframe", "src", None)]
CSS_URL_RE = re.compile(r"""url\(\s*['"]?([^'")]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]""", re.I)
IMG_EXT_RE = re.compile(r"\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)(\?|$)", re.I)
SOFT404_RE = re.compile(r"\b(404|not found|page not found|p[áa]gina n[ãa]o encontrada|n[ãa]o encontrad[ao]|"
                        r"p[áa]gina no encontrada|no encontrad[ao]|nothing found|nada encontrado|does ?n.t exist|"
                        r"n[ãa]o existe|no existe)\b", re.I)
WEAK_ANCHORS = {"clique aqui", "aqui", "saiba mais", "leia mais", "veja mais", "mais", "click here", "here",
                "read more", "learn more", "more", "link", "this", "este link", "ver mais"}


@dataclass
class CrawlConfig:
    start_url: str = ""
    mode: str = "spider"              # spider | list
    url_list: list = field(default_factory=list)
    max_urls: int = 500
    max_depth: int = 10
    concurrency: int = 5
    timeout: float = 20.0
    retries: int = 2
    max_rps: float = 0                # 0 = unlimited
    max_page_kb: int = 5120
    respect_robots: bool = True
    respect_crawl_delay: bool = True
    crawl_sitemaps: bool = False
    check_external: bool = True
    check_images: bool = True
    crawl_subdomains: bool = False
    scope: str = "subdomain"          # subdomain | subfolder | all_subdomains
    crawl_resources: bool = True      # CSS, JS, fonts, media, internal images
    include: list = field(default_factory=list)
    exclude: list = field(default_factory=list)
    strip_params: str = "utm_*, fbclid, gclid"
    strip_all_params: bool = False
    auth_user: str = ""
    auth_pass: str = ""
    render_js: bool = False
    near_dup_threshold: int = 90
    spelling: bool = False
    spell_lang: str = "auto"          # auto = from <html lang>, fallback English
    spell_ignore: list = field(default_factory=list)
    semantic: bool = True
    semantic_threshold: float = 0.9
    extractors: list = field(default_factory=list)  # [{name, type: css|xpath|regex, expr, attr}]
    custom_js: list = field(default_factory=list)   # [{name, type: extraction|action, content_type, timeout, code}]
    custom_search: list = field(default_factory=list)  # [{name, mode: contains|not_contains, type: text|regex, where: html|text, case}]
    user_agent: str = "SEOSpiderClone/1.0"
    custom_headers: list = field(default_factory=list)  # ["Accept-Language: de-DE", "Cookie: a=b"]
    proxy: str = ""                                      # http://user:pass@host:port
    robots_override: str = ""                            # custom robots.txt for the crawled site
    auth_cookies: list = field(default_factory=list)     # cookies captured by forms-based login
    accessibility: bool = False                          # axe-core audit in Chromium (SF Accessibility tab)
    max_folder_depth: int = -1         # -1 = unlimited
    max_query_strings: int = -1        # -1 = unlimited
    max_url_length: int = 2000
    max_links_per_url: int = 10000
    max_redirects: int = 5
    path_limits: list = field(default_factory=list)   # ["/blog/ | 100"]  (regex | max URLs)
    url_rewrite: list = field(default_factory=list)   # ["regex -> replacement"]
    lowercase_urls: bool = False
    cdn_domains: list = field(default_factory=list)   # hosts treated as internal
    follow_internal_nofollow: bool = False
    # Spider > Crawl: crawl / store per link type
    store_images: bool = True
    crawl_media: bool = False
    store_media: bool = False
    crawl_css: bool = True
    store_css: bool = True
    crawl_js: bool = True
    store_js: bool = True
    crawl_swf: bool = True
    store_swf: bool = True
    crawl_internal: bool = True
    store_internal: bool = True
    store_external: bool = True
    crawl_canonicals: bool = True
    store_canonicals: bool = True
    crawl_pagination: bool = False
    store_pagination: bool = True
    crawl_hreflang: bool = False
    store_hreflang: bool = True
    crawl_amp: bool = False
    store_amp: bool = False
    crawl_meta_refresh: bool = True
    store_meta_refresh: bool = True
    crawl_iframes: bool = True
    store_iframes: bool = True
    crawl_mobile_alt: bool = False
    store_mobile_alt: bool = False
    store_uncrawlable: bool = False        # Spider > Crawl: Uncrawlable Links (stored and reported, never crawled)
    crawl_invalid_links: bool = False     # Spider > Crawl: follow links that are not valid URLs (e.g. hppt://)
    check_outside_folder: bool = True
    crawl_outside_folder: bool = True
    follow_external_nofollow: bool = False
    sitemap_auto: bool = True
    sitemap_list: list = field(default_factory=list)
    # Spider > Extraction
    ex_title: bool = True
    ex_meta_desc: bool = True
    ex_meta_keywords: bool = True
    ex_h1: bool = True
    ex_h2: bool = True
    ex_indexability: bool = True
    ex_word_count: bool = True
    ex_readability: bool = True
    ex_text_ratio: bool = True
    ex_hash: bool = True
    ex_page_size: bool = True
    ex_forms: bool = True
    ex_response_time: bool = True
    ex_last_modified: bool = True
    store_headers: bool = True
    store_cookies: bool = True
    ex_meta_robots: bool = True
    ex_x_robots: bool = True
    extract_jsonld: bool = False
    extract_microdata: bool = False
    extract_rdfa: bool = False
    sd_schema_validation: bool = True
    sd_google_validation: bool = True
    store_html: bool = True
    store_rendered: bool = True
    extract_pdf_props: bool = True
    # Spider > Limits
    max_per_depth: int = 0        # 0 = unlimited
    max_per_subdomain: int = 0    # 0 = unlimited
    # Spider > Rendering
    render_wait: float = 0
    viewport: str = "desktop"
    # Spider > Advanced
    cookie_storage: str = "session"   # session | persistent | none
    ignore_nonindexable_issues: bool = True
    ignore_paginated_dups: bool = True
    always_follow_redirects: bool = False
    always_follow_canonicals: bool = False
    respect_noindex: bool = False
    respect_canonical: bool = False
    respect_next_prev: bool = False
    respect_hsts: bool = True
    respect_self_meta_refresh: bool = False
    img_srcset: bool = True
    crawl_fragments: bool = False
    html_validation: bool = True
    carbon: bool = False
    waf_fallback: bool = True     # retry WAF-blocked pages through the browser (Playwright)
    assume_html: bool = False
    # Spider > Preferences
    prefs: dict = field(default_factory=dict)
    weak_anchors: list = field(default_factory=lambda: list(DEFAULT_WEAK_ANCHORS))
    soft404_phrases: list = field(default_factory=lambda: list(DEFAULT_SOFT404))
    # Content
    content_mode: str = "exclude"
    content_tags: list = field(default_factory=lambda: ["nav", "footer"])
    content_classes: list = field(default_factory=list)
    content_ids: list = field(default_factory=list)
    content_alt: bool = False
    dup_indexable_only: bool = True
    near_dups: bool = False
    grammar: bool = False
    spell_dictionary: list = field(default_factory=list)
    grammar_disabled: list = field(default_factory=list)
    semantic_similarity: bool = True
    semantic_indexable_only: bool = True
    semantic_ignore_paginated: bool = True
    low_relevance_on: bool = True
    low_relevance_threshold: float = 0     # 0 = automatic (mean - 2 std)
    low_relevance_indexable_only: bool = True
    low_relevance_ignore_paginated: bool = False
    embedding_rules: list = field(default_factory=list)   # ["Incluir | regex", "Excluir | regex"]
    embedding_prompt: str = ""
    # Custom > Link Positions, robots.txt, URL Rewriting, User-Agent
    link_positions: list = field(default_factory=list)    # ["Posição | regex sobre tag#id.classe"]
    robots_mode: str = "respect"          # respect | ignore | report
    robots_ua: str = ""
    show_internal_blocked: bool = True
    show_external_blocked: bool = False
    robots_custom: dict = field(default_factory=dict)     # host -> robots.txt text
    url_pct_case: str = "upper"
    link_pos_enabled: bool = True
    allow_standards_auth: bool = True
    auth_entries: list = field(default_factory=list)      # [{host, user, pass}] (never saved to disk)
    autosave: bool = True                                  # File > Settings > Storage Mode (database = auto save)
    analysis: list = field(default_factory=lambda: list(ANALYSIS_GROUPS))  # Configuration > Crawl Analysis
    auto_analyse: bool = True                                               # analyse at end of crawl


LINK_POSITIONS = [("nav", "Navegação"), ("header", "Cabeçalho"), ("footer", "Rodapé"), ("aside", "Lateral")]
_POS_ROLE = {"navigation": "Navegação", "banner": "Cabeçalho", "contentinfo": "Rodapé", "complementary": "Lateral"}
_POS_HINT = [(re.compile(r"(^|[-_ ])(nav|menu|breadcrumb)", re.I), "Navegação"),
             (re.compile(r"(^|[-_ ])(header|topbar|masthead)", re.I), "Cabeçalho"),
             (re.compile(r"(^|[-_ ])(footer|colophon)", re.I), "Rodapé"),
             (re.compile(r"(^|[-_ ])(sidebar|aside|widget)", re.I), "Lateral")]


RES_EXT = {"css": "css", "woff": "css", "woff2": "css", "ttf": "css", "otf": "css", "eot": "css",
           "js": "js", "mjs": "js", "swf": "swf",
           "png": "images", "jpg": "images", "jpeg": "images", "gif": "images", "webp": "images", "svg": "images",
           "avif": "images", "ico": "images", "bmp": "images",
           "mp4": "media", "webm": "media", "mp3": "media", "ogg": "media", "wav": "media", "mov": "media", "m4a": "media"}
TAG_CAT = {("script", None): "js", ("link", "stylesheet"): "css", ("link", "icon"): "images", ("video", None): "media",
           ("audio", None): "media", ("source", None): "media"}
KIND_CAT = {"canonical": "canonicals", "pagination": "pagination", "hreflang": "hreflang", "amphtml": "amp",
            "alternate": "mobile_alt", "meta_refresh": "meta_refresh", "iframe": "iframes"}
CRAWL_FLAG = {"external": "check_external", "images": "check_images"}
VIEWPORTS = {"desktop": {"width": 1024, "height": 768}, "mobile": {"width": 411, "height": 731}}


def res_cat(url):
    ext = (re.search(r"\.([a-z0-9]{2,5})$", urlparse(url).path.lower()) or [None, ""])[1]
    return RES_EXT.get(ext, "js" if not ext else "css")


def path_type(href):
    """Absolute / Protocol-Relative / Root-Relative / Path-Relative (as written in the HTML)."""
    h = (href or "").strip()
    if re.match(r"^[a-z][a-z0-9+.-]*:", h, re.I):
        return "Absoluto"
    if h.startswith("//"):
        return "Relativo ao protocolo"
    if h.startswith("/"):
        return "Relativo à raiz"
    return "Relativo ao caminho"


def link_xpath(el):
    """Link Path: XPath of the element, e.g. /html/body/header/nav/ul/li[3]/a."""
    parts = []
    node = el
    while node is not None and getattr(node, "name", None) and node.name != "[document]":
        name = node.name
        parent = node.parent
        if parent is not None and name not in ("html", "body", "head"):
            same = parent.find_all(name, recursive=False)
            if len(same) > 1:
                name = f"{name}[{next(i for i, s in enumerate(same, 1) if s is node)}]"
        parts.append(name)
        node = parent
        if len(parts) > 60:
            break
    return "/" + "/".join(reversed(parts))


def link_position(a):
    """Classify a link by where it sits in the page template (SF 'Link Position')."""
    for el in a.parents:
        name = getattr(el, "name", None)
        if not name or name in ("body", "html", "[document]"):
            break
        for tag, label in LINK_POSITIONS:
            if name == tag:
                return label
        role = (el.get("role") or "").lower()
        if role in _POS_ROLE:
            return _POS_ROLE[role]
        hint = " ".join([el.get("id") or ""] + list(el.get("class") or []))
        if hint:
            for rx, label in _POS_HINT:
                if rx.search(hint):
                    return label
    return "Conteúdo"


def clean_text(s):
    """Collapse whitespace runs to a single space and trim (matches how SF renders title/H1/extracted text)."""
    return " ".join((s or "").split())


def parse_headers(lines):
    out = {}
    for line in lines or []:
        if ":" in line:
            k, v = line.split(":", 1)
            if k.strip():
                out[k.strip()] = v.strip()
    return out


def normalize(url):
    url, _ = urldefrag(url.strip())
    p = urlparse(url)
    scheme = p.scheme.lower()
    host = (p.hostname or "").lower()
    port = p.port
    netloc = host
    if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        netloc = f"{host}:{port}"
    return urlunparse((scheme, netloc, p.path or "/", p.params, p.query, ""))


def waf_name(headers):
    """Identify a bot-protection firewall from response headers, if any."""
    server = headers.get("server", "").lower()
    if "cf-ray" in headers or "cloudflare" in server:
        return "Cloudflare"
    if "akamai" in server or "x-akamai-transformed" in headers or "akamai-grn" in headers:
        return "Akamai"
    if "x-sucuri-id" in headers or "sucuri" in server:
        return "Sucuri"
    if "x-amzn-waf-action" in headers or "awselb" in server:
        return "AWS WAF"
    if "x-iinfo" in headers or "incapsula" in headers.get("x-cdn", "").lower():
        return "Imperva"
    if "x-datadome" in headers or "datadome" in server:
        return "DataDome"
    return None


def bare_host(url):
    h = (urlparse(url).hostname or "").lower()
    return h[4:] if h.startswith("www.") else h


def public(rec):
    return {k: v for k, v in rec.items() if not k.startswith("_")}


class Crawler:
    def __init__(self, cfg: CrawlConfig):
        self._page_links = {}   # url -> link dicts of the page being parsed (Link Origin in JS rendering mode)
        self.cfg = cfg
        self._strip = [p.strip().lower() for p in re.split(r"[,\n]", cfg.strip_params) if p.strip()]
        self._include = [re.compile(p) for p in cfg.include if p.strip()]
        self._exclude = [re.compile(p) for p in cfg.exclude if p.strip()]
        self._path_limits = []
        for line in cfg.path_limits:
            pat, _, n = line.rpartition("|")
            if pat.strip() and n.strip().isdigit():
                self._path_limits.append(dict(re=re.compile(pat.strip()), max=int(n.strip()), n=0, pat=pat.strip()))
        self._rewrite = []
        for line in cfg.url_rewrite:
            pat, sep, repl = line.partition("->")
            if sep and pat.strip():
                self._rewrite.append((re.compile(pat.strip()), repl.strip()))
        self._cdns = []
        for h in cfg.cdn_domains:
            if h.strip():
                pu = urlparse(h.strip() if "://" in h else "http://" + h.strip())
                self._cdns.append((bare_host(pu.geturl()), pu.path if pu.path not in ("", "/") else ""))
        self._link_pos = []
        for line in cfg.link_positions if cfg.link_pos_enabled else []:
            name, _, term = line.partition("|")
            if name.strip() and term.strip():
                self._link_pos.append((name.strip(), term.strip().lower()))
        self._embed_rules = []
        for line in cfg.embedding_rules:
            mode, _, rx = line.partition("|")
            if rx.strip():
                self._embed_rules.append((mode.strip().lower().startswith(("exc", "exclu")), re.compile(rx.strip())))
        self._no_follow = set()
        self._depth_count = Counter()
        self._host_count = Counter()
        self.green_hosts = {}
        self._link_count = Counter()
        self._redir_hops = {}
        for ex in cfg.extractors:
            if ex.get("type") == "regex":
                ex["_re"] = re.compile(ex["expr"], re.I | re.S)
        for cs in cfg.custom_search:
            pat = cs.get("query", "")
            flags = 0 if cs.get("case") else re.I
            cs["_re"] = re.compile(pat if cs.get("type") == "regex" else re.escape(pat), flags)
        seeds = cfg.url_list if cfg.mode == "list" else [cfg.start_url]
        self.seeds = list(dict.fromkeys(u for u in map(self.norm, seeds) if u))
        if not self.seeds:
            raise ValueError("Nenhuma URL válida para rastrear")
        self.start_url = self.seeds[0]
        self.roots = {bare_host(u) for u in self.seeds}
        import uuid
        self.crawl_id = uuid.uuid4().hex[:12]
        self.crawl_name = f"{urlparse(self.start_url).hostname} — {time.strftime('%Y-%m-%d %H:%M')}"
        self.project = ""
        self.folder = urlparse(self.start_url).path.rsplit("/", 1)[0] + "/"

        self.pages = {}
        self.external = {}
        self.images = {}
        self.links = []        # {src, dst, anchor, kind, nofollow, internal}
        self.image_refs = []   # {page, src, alt}
        self.parent = {}       # url -> first page that linked to it
        self.skipped = {}      # url -> (reason, discovered on) for URLs found but not crawled
        self.hsts_hosts = set()
        self.robots_text = {}  # host -> robots.txt text (for the tester)
        self.api_urls = {}     # url -> {"ga4", "gsc"} found in Analytics/Search Console but not crawled
        self._extra_seeds = {} # url -> source for URLs crawled from GA4/GSC
        self.sitemaps = []
        self.sitemap_urls = set()
        self.sitemap_hits = {}   # url -> number of sitemaps listing it
        self.sitemap_info = []   # [{url, urls, size}]
        self.browser_cookies = []  # cookie jar of the rendering browser (JavaScript-set cookies)
        self._sitemap_seeds = set()
        self.near_dups = {}
        self.semantic = None   # {"index": ..., "urls": [...], "related": {url: [(url, score)]}}
        self.finalized = False
        self.analysed = set()   # crawl-analysis groups calculated for the current data
        self.analysis = {"running": False, "done": 0, "total": 0}
        self.psi = {"running": False, "done": 0, "total": 0, "errors": 0}
        self.grammar = {"running": False, "done": 0, "total": 0, "errors": 0}

        self.status = "running"
        self.phase = ""
        self.error = ""
        self.started = time.time()
        self.finished = None
        self.robots = {}
        self._robots_lock = defaultdict(asyncio.Lock)
        self._slot_lock = defaultdict(asyncio.Lock)
        self._next_slot = defaultdict(float)
        self._seen = set()
        self._queue = asyncio.Queue()
        self._stop = False
        self._browser = None
        self.ai_bridge = None  # async callable used by seoSpider.openai() inside snippets

    # ---------- lifecycle ----------
    def stop(self):
        self._stop = True

    def _client(self):
        headers = {"User-Agent": self.cfg.user_agent,
                   "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                   "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8"}
        headers.update(parse_headers(self.cfg.custom_headers))
        cookies = httpx.Cookies()
        for c in self.cfg.auth_cookies:
            cookies.set(c["name"], c["value"], domain=c.get("domain", ""), path=c.get("path", "/"))
        return httpx.AsyncClient(headers=headers, cookies=cookies, timeout=self.cfg.timeout, follow_redirects=False,
                                 proxy=self.cfg.proxy or None, verify=ssl_context(),
                                 limits=httpx.Limits(max_connections=self.cfg.concurrency * 2))

    async def run(self):
        try:
            async with self._client() as client:
                self.client = client
                await asyncio.to_thread(schema_vocab)  # downloads the Schema.org vocabulary once
                if self.cfg.accessibility:
                    self.phase = "Preparando auditoria de acessibilidade (axe-core)"
                    try:
                        self._axe = await asyncio.to_thread(axe_source)
                    except Exception as e:
                        self._axe, self.a11y_error = None, f"axe-core indisponível: {e}"[:200]
                if self.cfg.render_js or self.cfg.custom_js or self.cfg.accessibility:
                    self.phase = "Iniciando navegador (renderização JS)"
                    await self._start_browser()
                if self.cfg.mode == "spider":
                    self.phase = "Lendo robots.txt e sitemaps"
                    await self._load_sitemaps()
                self.phase = "Rastreando páginas"
                for s in self.seeds:
                    self._enqueue(s, 0, seed=True)
                workers = [asyncio.create_task(self._worker()) for _ in range(self.cfg.concurrency)]
                await self._queue.join()
                start_ok = 200 <= ((self.pages.get(self.start_url) or {}).get("status") or 0) < 400
                if self.cfg.mode == "spider" and self.cfg.crawl_sitemaps and start_ok and not self._stop:
                    self.phase = "Rastreando URLs encontradas só na sitemap"
                    for u in sorted(self.sitemap_urls):
                        if self.is_internal(u) and u not in self._seen:
                            self._sitemap_seeds.add(u)
                            self._enqueue(u, 0, seed=True)
                    await self._queue.join()
                for w in workers:
                    w.cancel()
                if self._browser:
                    try:
                        self.browser_cookies = await self._ctx.cookies()
                    except Exception:
                        pass
                if self.cfg.check_external and not self._stop:
                    self.phase = "Verificando links externos"
                    await self._check_resources(self.external)
                if self.cfg.check_images and not self._stop:
                    self.phase = "Verificando imagens"
                    await self._check_resources(self.images)
            await self._end_of_crawl()
            self.status = "stopped" if self._stop else "finished"
        except Exception as e:
            self.status = "error"
            self.error = f"{type(e).__name__}: {e}"
        finally:
            await self._close_browser()
            self.phase = ""
            self.finished = time.time()

    async def _end_of_crawl(self):
        if self.cfg.auto_analyse:
            self.phase = "Análise de crawl"
            await asyncio.to_thread(self.finalize)
        elif self.cfg.spelling:  # spelling is reported at run time, like in SF
            self.phase = "Verificando ortografia"
            await asyncio.to_thread(self._spellcheck, [p for p in list(self.pages.values()) if is_html(p)])

    async def crawl_more(self, urls, source):
        """Crawl extra URLs (e.g. found in GA4 / Search Console) into the existing crawl, then re-analyse."""
        self.status, self.finished, self._stop, self.error = "running", None, False, ""
        self.analysed = set()  # new URLs invalidate the crawl analysis
        self.cfg.max_urls += len(urls)
        try:
            async with self._client() as client:
                self.client = client
                if self.cfg.render_js or self.cfg.custom_js or self.cfg.accessibility:
                    await self._start_browser()
                self.phase = "Rastreando URLs do GA4 / Search Console"
                for u in urls:
                    if u not in self._seen:
                        self._extra_seeds[u] = source.get(u, "api") if isinstance(source, dict) else source
                        self._enqueue(u, 0, seed=True)
                workers = [asyncio.create_task(self._worker()) for _ in range(self.cfg.concurrency)]
                await self._queue.join()
                for w in workers:
                    w.cancel()
            await self._end_of_crawl()
            self.status = "stopped" if self._stop else "finished"
        except Exception as e:
            self.status = "error"
            self.error = f"{type(e).__name__}: {e}"
        finally:
            await self._close_browser()
            self.phase = ""
            self.finished = time.time()

    def progress(self):
        done = sum(1 for p in self.pages.values() if p["status"] is not None)
        elapsed = round((self.finished or time.time()) - self.started, 1)
        return dict(
            status=self.status, phase=self.phase, error=self.error, start_url=self.start_url,
            mode=self.cfg.mode, analysis=dict(self.analysis), analysed=sorted(self.analysed),
            auto_analyse=self.cfg.auto_analyse, crawled=done, discovered=len(self._seen), queued=self._queue.qsize(),
            external=len(self.external), images=len(self.images), max_urls=self.cfg.max_urls,
            sitemaps=len(self.sitemaps), sitemap_urls=len(self.sitemap_urls),
            elapsed=elapsed, rate=round(done / elapsed, 2) if elapsed else 0,
            render_js=self.cfg.render_js, psi=self.psi, grammar=self.grammar,
            start_status=(self.pages.get(self.start_url) or {}).get("status"),
            start_status_text=(self.pages.get(self.start_url) or {}).get("status_text", ""),
        )

    # ---------- URL handling ----------
    def norm(self, url):
        frag = urldefrag(url.strip())[1] if self.cfg.crawl_fragments else ""
        try:
            u = normalize(url)
        except ValueError:
            return None
        if not u.startswith(("http://", "https://")):
            return None
        p = urlparse(u)
        if p.query and (self.cfg.strip_all_params or self._strip):
            q = [] if self.cfg.strip_all_params else [
                (k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
                if not any(fnmatch.fnmatch(k.lower(), pat) for pat in self._strip)]
            u = urlunparse(p._replace(query=urlencode(q)))
        if self._rewrite or self.cfg.lowercase_urls:
            for rx, repl in self._rewrite:
                u = rx.sub(repl, u)
            if self.cfg.lowercase_urls:
                u = u.lower()
            try:
                u = normalize(u)
            except ValueError:
                return None
            if not u.startswith(("http://", "https://")):
                return None
        u = re.sub(r"%[0-9a-fA-F]{2}", lambda m: m.group(0).lower() if self.cfg.url_pct_case == "lower" else m.group(0).upper(), u)
        return u + "#" + frag if frag else u

    def _resolve(self, base, href):
        href = (href or "").strip()
        if not href or href.startswith("#") or href.lower().startswith(SKIP_SCHEMES):
            return None
        try:
            url = urljoin(base, href)
        except ValueError:
            return None
        u = urlparse(url)
        if u.scheme not in ("http", "https") or not u.hostname:
            # invalid URL (hppt://x, http:///x ...): only kept when "Crawl Invalid Links" is on, reported as No Response
            return url if self.cfg.crawl_invalid_links and "://" in url else None
        try:
            return self.norm(url)
        except ValueError:
            return url if self.cfg.crawl_invalid_links else None

    def _uncrawlable(self, soup, base):
        """Links Google can't follow: no <a href>, e.g. <span href>, <a data-href>, onclick="location=...", href="javascript:..."."""
        out = []
        for el in soup.find_all(True, limit=20000):
            name, href, how = el.name, None, ""
            ahref = (el.get("href") or "").strip() if name == "a" else ""
            if name not in LINK_TAGS and el.get("href"):
                href, how = el["href"], f"<{name} href>"
            elif name == "a" and not ahref:
                for attr in ROUTE_ATTRS:
                    if el.get(attr):
                        href, how = el[attr], f"<a {attr}>"
                        break
            if not href and (name != "a" or not ahref or ahref.lower().startswith("javascript:")):
                js = el.get("onclick") or ""
                m = JS_URL_RE.search(js) if js else None
                if m:
                    href, how = m.group(1), "onclick"
                elif ahref.lower().startswith("javascript:"):
                    m = JS_URL_RE.search(ahref) or JS_PATH_RE.search(ahref)
                    if m:
                        href, how = m.group(1), "href=javascript:"
            if href and isinstance(href, str):
                dst = self._resolve(base, href)
                if dst:
                    out.append((el, dst, how))
            if len(out) >= 1000:
                break
        return out

    def is_internal(self, url):
        h = bare_host(url)
        subs = self.cfg.crawl_subdomains or self.cfg.scope == "all_subdomains"
        return h in self.roots or (subs and any(h.endswith("." + r) for r in self.roots)) or \
            any((h == c or h.endswith("." + c)) and (not cp or urlparse(url).path.startswith(cp)) for c, cp in self._cdns)

    def _outside_folder(self, url):
        return (self.cfg.scope == "subfolder" or not self.cfg.crawl_outside_folder) and \
            not urlparse(url).path.startswith(self.folder)

    def _allowed(self, url, seed, resource=False):
        if any(r.search(url) for r in self._exclude):
            return False
        if seed or resource:
            return True
        if self._outside_folder(url) and not self.cfg.check_outside_folder:
            return False
        return not self._include or any(r.search(url) for r in self._include)

    def _skip(self, url, reason, parent=None):
        if url not in self._seen and url not in self.skipped and len(self.skipped) < 100000:
            self.skipped[url] = (reason, parent or "")

    def _skip_reason(self, url, depth, seed, resource):
        if any(r.search(url) for r in self._exclude):
            return "Excluída pela regra Excluir"
        if seed or resource:
            pass
        elif self._outside_folder(url) and not self.cfg.check_outside_folder:
            return "Fora da subpasta inicial"
        elif self._include and not any(r.search(url) for r in self._include):
            return "Não corresponde à regra Incluir"
        if not seed:
            p = urlparse(url)
            if self.cfg.max_url_length and len(url) > self.cfg.max_url_length:
                return "URL acima do comprimento máximo"
            if self.cfg.max_folder_depth >= 0 and len([s for s in p.path.rsplit("/", 1)[0].split("/") if s]) > self.cfg.max_folder_depth:
                return "Profundidade máxima de pastas atingida"
            if self.cfg.max_query_strings >= 0 and p.query and len(parse_qsl(p.query, keep_blank_values=True)) > self.cfg.max_query_strings:
                return "Limite de parâmetros de query atingido"
            if self.cfg.max_per_depth and self._depth_count[depth] >= self.cfg.max_per_depth:
                return "Limite de URLs por profundidade atingido"
            if self.cfg.max_per_subdomain and self._host_count[p.hostname] >= self.cfg.max_per_subdomain:
                return "Limite de URLs por subdomínio atingido"
            if not resource:
                for pl in self._path_limits:
                    if pl["re"].search(url) and pl["n"] >= pl["max"]:
                        return f"Limite por caminho atingido ({pl['pat']})"
        if depth > self.cfg.max_depth:
            return "Profundidade máxima atingida"
        if len(self._seen) >= self.cfg.max_urls:
            return "Limite de URLs atingido"
        if self._stop:
            return "Crawl interrompido"
        return None

    def _enqueue(self, url, depth, seed=False, parent=None, resource=False):
        if url in self._seen:
            return
        reason = self._skip_reason(url, depth, seed, resource)
        if reason:
            self._skip(url, reason, parent)
            return
        self.skipped.pop(url, None)
        self._seen.add(url)
        self._depth_count[depth] += 1
        self._host_count[urlparse(url).hostname] += 1
        if not seed and self._outside_folder(url):
            self._no_follow.add(url)  # 'Check links outside of start folder': checked, not followed
        if not seed and not resource:
            for pl in self._path_limits:
                if pl["re"].search(url):
                    pl["n"] += 1
        if parent:
            self.parent[url] = parent
        self._queue.put_nowait((url, depth))

    # ---------- HTTP ----------
    def _auth(self, url):
        if not self.cfg.allow_standards_auth:
            return None
        host = (urlparse(url).hostname or "").lower()
        for e in self.cfg.auth_entries or []:
            h = (e.get("host") or "").lower().strip()
            h = (urlparse(h).hostname or h) if "://" in h else h.split("/")[0]
            if h and (host == h or host.endswith("." + h)) and e.get("user"):
                return httpx.BasicAuth(e["user"], e.get("pass", ""))
        if self.cfg.auth_user and self.is_internal(url):
            return httpx.BasicAuth(self.cfg.auth_user, self.cfg.auth_pass)
        return None

    async def _throttle(self, url):
        host = urlparse(url).netloc
        interval = 1 / self.cfg.max_rps if self.cfg.max_rps > 0 else 0
        if self.cfg.respect_crawl_delay:
            rp = self.robots.get(host)
            delay = rp.crawl_delay(self.cfg.user_agent) if rp else None
            if delay:
                interval = max(interval, float(delay))
        if not interval:
            return
        async with self._slot_lock[host]:
            now = time.monotonic()
            wait = self._next_slot[host] - now
            self._next_slot[host] = max(now, self._next_slot[host]) + interval
        if wait > 0:
            await asyncio.sleep(wait)

    async def _send(self, method, url, stream=False, follow_redirects=False):
        """Send a request with throttling and retries on network errors / 5xx."""
        last = None
        for attempt in range(self.cfg.retries + 1):
            if attempt:
                await asyncio.sleep(0.5 * 2 ** (attempt - 1))
            if self.is_internal(url):
                await self._throttle(url)
            try:
                r = await self.client.send(self.client.build_request(method, url), auth=self._auth(url),
                                           stream=stream, follow_redirects=follow_redirects)
            except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as e:
                last = e
                continue
            if r.status_code >= 500 and attempt < self.cfg.retries:
                await r.aclose()
                continue
            if self.cfg.waf_fallback and looks_like_waf_block(r.status_code, dict(r.headers)):
                await r.aclose()
                alt = await self._send_via_browser(url, follow_redirects)
                if alt is not None:
                    return alt
            return r
        raise last

    async def _send_via_browser(self, url, follow_redirects=True):
        """Retry a WAF-blocked request in Chromium: the firewall rejects the httpx TLS
        fingerprint, not the IP or the User-Agent (measured against certapro.com)."""
        try:
            if self._browser is None:
                await self._start_browser()
            if self._browser is None:
                return None
            return await fetch_with_browser(self._ctx, url)
        except Exception:
            return None
    async def _robots_for(self, url):
        p = urlparse(url)
        host = p.netloc
        if host in self.robots:
            return self.robots[host]
        async with self._robots_lock[host]:
            if host not in self.robots:
                rp = None
                custom = (self.cfg.robots_custom or {}).get(p.hostname or "", "")
                if custom.strip():
                    self.robots_text[host] = custom
                    rp = Robots(custom)
                elif self.cfg.robots_override.strip() and bare_host(url) in self.roots:
                    self.robots_text[host] = self.cfg.robots_override
                    rp = Robots(self.cfg.robots_override)
                else:
                    try:
                        r = await self._send("GET", f"{p.scheme}://{host}/robots.txt", follow_redirects=True)
                        if r.status_code == 200:
                            self.robots_text[host] = r.text
                            rp = Robots(r.text)
                    except httpx.HTTPError:
                        pass
                self.robots[host] = rp
        return self.robots[host]

    async def _load_sitemaps(self):
        p = urlparse(self.start_url)
        rp = await self._robots_for(self.start_url)
        queue = list((rp.site_maps() if rp else None) or [f"{p.scheme}://{p.netloc}/sitemap.xml"]) if self.cfg.sitemap_auto else []
        queue += [u.strip() for u in self.cfg.sitemap_list if u.strip()]
        seen = set()
        cap = max(self.cfg.max_urls * 20, 20000)
        while queue and len(seen) < 50 and len(self.sitemap_urls) < cap and not self._stop:
            sm = queue.pop(0)
            if sm in seen:
                continue
            seen.add(sm)
            try:
                r = await self._send("GET", sm, follow_redirects=True)
                content = r.content
                if content[:2] == b"\x1f\x8b":
                    content = gzip.decompress(content)
                root = ET.fromstring(content)
            except Exception:
                continue
            if r.status_code != 200:
                continue
            self.sitemaps.append(sm)
            locs = [el.text.strip() for el in root.iter() if el.tag.split("}")[-1] == "loc" and el.text]
            if root.tag.split("}")[-1] == "sitemapindex":
                queue += locs
            else:
                normed = [u for u in map(self.norm, locs[:50000]) if u]
                self.sitemap_urls.update(normed)
                for u in set(normed):
                    self.sitemap_hits[u] = self.sitemap_hits.get(u, 0) + 1
                self.sitemap_info.append(dict(url=sm, urls=len(locs), size=len(content)))

    # ---------- JS rendering ----------
    async def _start_browser(self):
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise RuntimeError("Playwright não instalado: rode 'pip install playwright' e 'playwright install chromium'")
        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.launch(proxy={"server": self.cfg.proxy} if self.cfg.proxy else None)
        creds = None
        first = next((e for e in self.cfg.auth_entries or [] if e.get("user")), None) if self.cfg.allow_standards_auth else None
        if first or self.cfg.auth_user:
            p = urlparse(self.start_url)
            creds = {"username": first["user"] if first else self.cfg.auth_user,
                     "password": first.get("pass", "") if first else self.cfg.auth_pass, "origin": f"{p.scheme}://{p.netloc}"}
        # bypass_csp lets snippets call external APIs even on sites with a strict Content-Security-Policy
        self._ctx = await self._browser.new_context(user_agent=self.cfg.user_agent, http_credentials=creds,
                                                    viewport=VIEWPORTS.get(self.cfg.viewport, VIEWPORTS["desktop"]),
                                                    bypass_csp=bool(self.cfg.custom_js),
                                                    extra_http_headers=parse_headers(self.cfg.custom_headers))
        if self.cfg.auth_cookies:
            await self._ctx.add_cookies(self.cfg.auth_cookies)
        if self.cfg.custom_js:
            await self._ctx.expose_function("__sfOpenAI", self._ai_call)
        self._render_sem = asyncio.Semaphore(min(self.cfg.concurrency, 4))

    async def _close_browser(self):
        if self._browser:
            try:
                await self._browser.close()
                await self._pw.stop()
            except Exception:
                pass
            self._browser = None

    async def _ai_call(self, payload):
        if not self.ai_bridge:
            raise RuntimeError("seoSpider.openai indisponível")
        return await self.ai_bridge(json.loads(payload))

    def _snippets_for(self, ctype):
        return [(i, sn) for i, sn in enumerate(self.cfg.custom_js, 1) if snippet_matches(sn, ctype)]

    async def _browse(self, url, snippets, want_html):
        """Open the URL in Chromium: run action snippets, grab the rendered HTML, then extraction snippets."""
        results, info = {}, {"errors": []}
        async with self._render_sem:
            page = await self._ctx.new_page()
            page.on("pageerror", lambda e: info["errors"].append(str(e)[:300]))
            page.on("console", lambda m: m.type == "error" and info["errors"].append(m.text[:300]))
            try:
                await page.goto(url, wait_until="networkidle", timeout=self.cfg.timeout * 1000)
                if self.cfg.render_wait:
                    await page.wait_for_timeout(int(self.cfg.render_wait * 1000))
                info["final_url"] = page.url
                for i, sn in snippets:
                    if sn.get("type") == "action":
                        results[i] = await run_snippet(page, sn)
                html = await page.content() if want_html else None
                if self.cfg.accessibility:
                    info["axe"] = await run_axe(page, getattr(self, "_axe", None))
                for i, sn in snippets:
                    if sn.get("type") != "action":
                        results[i] = await run_snippet(page, sn)
                return html, results, info
            finally:
                await page.close()

    def _store_js(self, rec, results):
        for i, (value, error) in results.items():
            rec[f"js{i}"] = value if error is None else f"[erro] {error}"

    # ---------- crawling ----------
    async def _worker(self):
        while True:
            url, depth = await self._queue.get()
            try:
                if not self._stop:
                    await self._fetch_page(url, depth)
            except Exception as e:
                rec = self.pages.setdefault(url, self._blank(url, depth))
                rec.update(status=0, status_text=f"{type(e).__name__}: {e}"[:200],
                           indexability="Non-Indexable", indexability_reason="Sem resposta")
            finally:
                self._queue.task_done()

    @staticmethod
    def _blank(url, depth):
        return dict(
            url=url, status=None, status_text="", content_type="", size=0, response_ms=None,
            depth=depth, parent="", redirect_url="", redirect_hops=0, redirect_final="",
            redirect_final_status=None, redirect_loop=False, indexability="", indexability_reason="",
            title="", title_len=0, title_px=0, meta_desc="", md_len=0, md_px=0, meta_keywords="",
            h1_1="", h1_2="", h1_count=0, h1_len=0, h2_1="", h2_2="", h2_count=0,
            canonical="", meta_robots="", x_robots="", lang="", pag_next="", pag_prev="",
            hreflang_count=0, hreflang_issues="", sd_types="", sd_errors=0, sd_warnings="",
            og_title="", og_description="", og_image="", og_type="", twitter_card="",
            word_count=0, content_hash="", near_dup_count=None, closest_similarity=None,
            inlinks=0, unique_inlinks=0, outlinks=0, external_outlinks=0, link_score=None,
            images=0, images_missing_alt=0, broken_outlinks=0, mixed_content=0, sec_missing="",
            nofollow_outlinks=0, weak_anchors=0, found_on=0, missing_alt=0,
            spelling_errors=None, grammar_errors=None, spell_lang="",
            semantic_similar=None, semantic_closest="", semantic_max=None, semantic_relevance=None, low_relevance=False,
            in_sitemap=False, not_in_sitemap=False, orphan=False, truncated=False, render_error="",
            psi_score=None, psi_lcp=None, psi_fcp=None, psi_cls=None, psi_tbt=None, psi_si=None,
            psi_field_lcp=None, psi_field_inp=None, psi_field_cls=None, psi_strategy="", psi_error="",
            psi_cwv="", psi_field_source="",
            url_len=len(url), issues=[], **{f: None for f in PAGE_FIELDS},
            found_via="link", robots_line="", sd_error_msgs="",
            val_missing_head=False, val_multiple_head=False, val_missing_body=False, val_multiple_body=False,
            val_body_before_html=False, val_head_not_first=False, val_invalid_head="", val_over_2mb=False, pdf_pages=None, hsts_http_links=0,
            content_inlinks=0, top_anchors="", unique_anchors=0,
            canonical_count=0, canonical_relative=False, canonical_outside_head=False, canonical_fragment=False,
            canonical_header="", canonical_mismatch=False, canonical_nonindexable=False,
            pag_multiple=False, pag_non200=False, pag_nonindexable=False, pag_unlinked=False,
            pag_sequence_error=False, pag_loop=False, in_ga=False, in_gsc=False,
            js_raw_words=None, js_word_diff_pct=None, js_links_only_rendered=None, js_title_changed=False,
            js_meta_changed=False, js_h1_changed=False, js_canonical_changed=False, js_noindex_only_rendered=False,
            title_count=0, title_outside_head=False, md_count=0, md_outside_head=False, robots_outside_head=False,
            h1_img_alt=False, h1_nonseq=False, h2_nonseq=False, h2_len=0,
            forms=0, form_on_http=False, form_insecure=False, unsafe_cross_origin=0, protocol_relative=0,
            meta_refresh="", meta_refresh_url="", js_redirect="", js_errors=None, js_error_msgs="",
            blocked_resource=False, blocked_resources=0, broken_bookmarks=0, noanchor_outlinks=0,
            mixed_inlinks=False, nofollow_only_inlinks=False, flesch=None, soft_404=False, lorem_ipsum=False,
            sd_formats="", sd_parse_error=False, hreflang_outside_head=False, sitemap_multi=False,
            missing_alt_attr=0, alt_long=0, missing_size=0, psi_opps="", psi_savings_ms=None,
            cookies=0, amp_url="", is_amp=False, amp_errors="", amp_non200=False, amp_no_return=False,
            viewport="", mob_no_device_width=False, mob_zoom_disabled=False, mob_plugins=0, mob_alternate="",
            a11y_rules=None, a11y_nodes=None, a11y_critical=None, a11y_serious=None, a11y_moderate=None,
            a11y_minor=None, a11y_ids="", a11y_level="", a11y_error="",
            canonical_unlinked=False, nonidx_inlinks_only=False, uncrawlable_outlinks=0,
            content_type_header="", transferred=None, http_version="", crawl_ts="", md5="", sentences=None, avg_wps=None,
            text_ratio=None, last_modified="", co2_mg=None, green_hosting=None, hidden=False, robots_blocked=False,
        )

    def _add_link(self, src, dst, anchor, kind, nofollow, depth, position="", cat=None, **extra):
        if self.cfg.respect_hsts and dst.startswith("http:") and urlparse(dst).hostname in self.hsts_hosts:
            dst = "https:" + dst[5:]
        internal = self.is_internal(dst)
        cat = "internal" if kind == "a" and internal else "external" if kind == "a" else \
            (cat or res_cat(dst)) if kind == "resource" else KIND_CAT.get(kind)
        crawl_ok = True
        if cat:  # Configuration > Spider > Crawl: Crawl / Store per link type
            crawl_ok = bool(getattr(self.cfg, CRAWL_FLAG.get(cat, "crawl_" + cat), True))
            if cat in ("css", "js", "media", "swf") and not self.cfg.crawl_resources:
                crawl_ok = False
            if not crawl_ok and not getattr(self.cfg, "store_" + cat, True):
                return
        link = dict(src=src, dst=dst, anchor=anchor[:200], kind=kind, nofollow=nofollow, internal=internal, position=position, **extra)
        if kind == "resource" and cat:
            link["cat"] = cat
        self.links.append(link)
        if src in self._page_links:
            self._page_links[src].append(link)
        if not crawl_ok:
            if internal:
                self._skip(dst, "Rastreamento desativado em Configuração > Spider > Rastreamento", src)
            elif dst not in self.external:
                self.external[dst] = dict(url=dst, status=None, status_text="", content_type="",
                                          size=None, response_ms=None, inlinks=0)
            return
        if internal:
            if (kind == "redirect" and self.cfg.always_follow_redirects) or \
                    (kind == "canonical" and self.cfg.always_follow_canonicals):
                self._enqueue(dst, (depth or 0) + 1, seed=True, parent=src)
            elif src in self._no_follow and kind == "a":
                self._skip(dst, "Só encontrada em página fora da subpasta inicial", src)
            elif nofollow and not self.cfg.follow_internal_nofollow:
                self._skip(dst, "Só encontrada em links nofollow", src)
            elif kind == "a" and dst not in self._seen and self._link_count[src] >= self.cfg.max_links_per_url:
                self._skip(dst, "Limite de links por página atingido", src)
            elif self.cfg.mode != "spider" and kind != "redirect":
                self._skip(dst, "Modo Lista: links não são seguidos", src)
            else:
                if kind == "a" and dst not in self._seen:
                    self._link_count[src] += 1
                self._enqueue(dst, (depth or 0) + 1, parent=src, resource=kind == "resource")
        elif nofollow and not self.cfg.follow_external_nofollow:
            return
        elif dst not in self.external:
            self.external[dst] = dict(url=dst, status=None, status_text="", content_type="",
                                      size=None, response_ms=None, inlinks=0)

    def _img_ref(self, url, src, alt, img, depth):
        self.image_refs.append(dict(page=url, src=src, alt=alt, sized=bool(img.get("width") and img.get("height")),
                                    w=str(img.get("width") or "")[:10], h=str(img.get("height") or "")[:10]))
        if self.is_internal(src):
            if self.cfg.check_images and self.cfg.mode == "spider":
                self._enqueue(src, (depth or 0) + 1, parent=url, resource=True)
            else:
                self._skip(src, "Rastreamento de imagens desligado" if self.cfg.mode == "spider"
                           else "Modo Lista: links não são seguidos", url)
        elif src not in self.images:
            self.images[src] = dict(url=src, status=None, status_text="", content_type="",
                                    size=None, response_ms=None, found_on=0, missing_alt=0)

    def _link_position(self, a):
        """Custom > Link Positions: first search term (substring) found in the link path, e.g. /html/body/header/div/a/."""
        if self._link_pos:
            path = "/" + "/".join(reversed([el.name for el in a.parents if getattr(el, "name", None) and el.name != "[document]"])) + "/a/"
            for label, term in self._link_pos:
                if term in path:
                    return label
        return link_position(a)

    def _content_text(self, soup):
        """Content > Content Area: the text used for word count, duplicates, spelling and n-grams."""
        for t in soup(["script", "style", "noscript", "template", "svg"]):
            t.decompose()
        if self.cfg.content_alt:
            for img in soup.find_all("img", alt=True):
                img.replace_with(" " + img["alt"] + " ")
        tags = {x.strip().lower() for x in self.cfg.content_tags if x.strip()}
        classes = {x.strip().lstrip(".") for x in self.cfg.content_classes if x.strip()}
        ids = {x.strip().lstrip("#") for x in self.cfg.content_ids if x.strip()}

        def hit(el):
            return el.name in tags or bool(classes & set(el.get("class") or [])) or el.get("id") in ids
        if self.cfg.content_mode == "include" and (tags or classes or ids):
            roots = [el for el in soup.find_all(True) if hit(el) and not any(hit(p) for p in el.parents if getattr(p, "name", None) and p.name != "[document]")]
            self._content_text_blocks = roots
            return " ".join(" ".join(r.get_text(" ").split()) for r in roots)
        for el in [el for el in soup.find_all(True) if hit(el)]:
            if not el.decomposed:
                el.decompose()
        self._content_text_blocks = soup.body or soup
        return " ".join((soup.body or soup).get_text(" ").split())

    def _apply_extraction(self, rec):
        """Spider > Extraction: data that was switched off is blanked."""
        c = self.cfg
        if not c.ex_title:
            rec.update(title="", title_len=0, title_px=0, title_count=0, title_outside_head=False)
        if not c.ex_meta_desc:
            rec.update(meta_desc="", md_len=0, md_px=0, md_count=0, md_outside_head=False)
        if not c.ex_meta_keywords:
            rec["meta_keywords"] = ""
        if not c.ex_h1:
            rec.update(h1_1="", h1_2="", h1_count=0, h1_len=0, h1_img_alt=False, h1_nonseq=False)
        if not c.ex_h2:
            rec.update(h2_1="", h2_2="", h2_count=0, h2_len=0, h2_nonseq=False)
        if not c.ex_word_count:
            rec["word_count"] = 0
        if not c.ex_readability:
            rec["flesch"] = None
        if not c.ex_text_ratio:
            rec["text_ratio"] = None
        if not c.ex_hash:
            rec["content_hash"] = ""
        if not c.ex_page_size:
            rec["size"] = None
        if not c.ex_forms:
            rec.update(forms=0, form_on_http=False, form_insecure=False)
        if not c.ex_response_time:
            rec["response_ms"] = None
        if not c.ex_last_modified:
            rec["last_modified"] = ""
        if not c.ex_meta_robots:
            rec["meta_robots"] = ""
        if not c.ex_x_robots:
            rec["x_robots"] = ""
        if not c.ex_indexability:
            rec.update(indexability="", indexability_reason="")

    async def _fetch_page(self, url, depth):
        extra = url in self._sitemap_seeds or url in self._extra_seeds
        rec = self._blank(url, None if extra else depth)
        rec["parent"] = self.parent.get(url, "")
        rec["in_sitemap"] = url in self.sitemap_urls
        rec["found_via"] = ("sitemap" if url in self._sitemap_seeds else self._extra_seeds.get(url)
                            or ("list" if self.cfg.mode == "list" and url in self.seeds else "link"))
        self.pages[url] = rec
        if self.cfg.respect_robots or self.cfg.robots_mode == "report":
            rp = await self._robots_for(url)
            if rp:
                allowed, line, _ = rp.check(url, self.cfg.robots_ua or self.cfg.user_agent)
                if not allowed and self.cfg.robots_mode == "report":
                    rec.update(robots_line=line or "", robots_blocked=True)  # ignored but reported
                elif not allowed:
                    rec.update(status=0, status_text="Bloqueado pelo robots.txt", robots_line=line or "",
                               indexability="Non-Indexable", indexability_reason="Bloqueado pelo robots.txt",
                               hidden=not self.cfg.show_internal_blocked)
                    return
        t0 = time.perf_counter()
        r = await self._send("GET", url, stream=True)
        if self.cfg.cookie_storage == "none" and not self.cfg.auth_cookies:
            self.client.cookies.clear()
        ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
        if not ctype and self.cfg.assume_html:
            ctype = "text/html"
        body, size, truncated = b"", 0, False
        try:
            if (ctype in HTML_TYPES or ctype in ("text/css", "application/pdf")) and not r.is_redirect and r.status_code < 400:
                limit = self.cfg.max_page_kb * 1024
                chunks = []
                async for chunk in r.aiter_bytes():
                    chunks.append(chunk)
                    size += len(chunk)
                    if size > limit:
                        truncated = True
                        break
                body = b"".join(chunks)
            else:
                cl = r.headers.get("content-length", "")
                size = int(cl) if cl.isdigit() else 0
        finally:
            await r.aclose()
        if self.cfg.store_headers:
            rec["_headers"] = dict(r.headers)
        rec["last_modified"] = r.headers.get("last-modified", "")
        set_cookies = r.headers.get_list("set-cookie") if self.cfg.store_cookies else []
        rec["cookies"] = len(set_cookies)
        if set_cookies:
            rec["_cookies"] = [parse_set_cookie(h, url) for h in set_cookies[:50]]
        if url.startswith("https:") and "strict-transport-security" in r.headers:
            self.hsts_hosts.add(urlparse(url).hostname)
        m = re.search(r'<([^>]+)>\s*;[^,]*rel="?canonical"?', r.headers.get("link", ""), re.I)
        if m:
            rec["canonical_header"] = self._resolve(url, m.group(1)) or m.group(1)
        transferred = r.num_bytes_downloaded or size
        rec.update(
            response_ms=round((time.perf_counter() - t0) * 1000), status=r.status_code,
            status_text=r.reason_phrase, content_type=ctype, size=size, truncated=truncated,
            x_robots=r.headers.get("x-robots-tag", ""), content_type_header=r.headers.get("content-type", ""),
            transferred=transferred, http_version=r.http_version.replace("HTTP/", ""),
            crawl_ts=time.strftime("%Y-%m-%d %H:%M:%S"), md5=hashlib.md5(body).hexdigest() if body else "",
            # Sustainable Web Design model v4: 0.3 kWh per GB transferred, 494 g CO2 per kWh (global grid)
            co2_mg=round(transferred / 1e9 * 0.3 * 494 * 1000, 3),
        )
        if self.cfg.carbon:  # green hosting lookup (The Green Web Foundation)
            host = urlparse(url).hostname
            if host not in self.green_hosts:
                self.green_hosts[host] = None
                try:
                    async with httpx.AsyncClient(timeout=10) as gc:
                        g = await gc.get(f"https://api.thegreenwebfoundation.org/api/v3/greencheck/{host}")
                        self.green_hosts[host] = bool(g.json().get("green"))
                except Exception:
                    pass
            rec["green_hosting"] = self.green_hosts.get(host)
        if r.is_redirect:
            target = self._resolve(url, r.headers.get("location"))
            rec.update(redirect_url=target or "", indexability="Non-Indexable",
                       indexability_reason="Redirecionado")
            if target:
                hops = self._redir_hops.get(url, 0) + 1
                if hops > self.cfg.max_redirects:
                    self.links.append(dict(src=url, dst=target, anchor="", kind="redirect", nofollow=False,
                                           internal=self.is_internal(target), position=""))
                    self._skip(target, "Limite de redirecionamentos seguidos atingido", url)
                else:
                    self._redir_hops[target] = hops
                    self._add_link(url, target, "", "redirect", False, depth)
            return
        if r.status_code >= 400:
            waf = waf_name(r.headers) if r.status_code in (403, 429, 503) else None
            if waf:
                rec["status_text"] = f"Bloqueado por WAF ({waf})"
            rec.update(indexability="Non-Indexable",
                       indexability_reason=f"Bloqueado por WAF ({waf})" if waf else
                       "Erro de cliente" if r.status_code < 500 else "Erro de servidor")
            return
        if ctype == "application/pdf" and body and self.cfg.extract_pdf_props:
            self._parse_pdf(rec, body, depth)
        if ctype == "text/css":
            css = body.decode(r.charset_encoding or "utf-8", "replace")
            for m in CSS_URL_RE.finditer(css):
                dst = self._resolve(url, m.group(1) or m.group(2))
                if dst:
                    self._add_link(url, dst, "", "resource", False, depth)
        if ctype in HTML_TYPES:
            missing = [label for h, label in SEC_HEADERS.items()
                       if h not in r.headers and not (h == "strict-transport-security" and url.startswith("http:"))]
            rec["sec_missing"] = ", ".join(missing)
            raw = UnicodeDammit(body, [r.charset_encoding] if r.charset_encoding else []).unicode_markup or ""
            if self.cfg.store_html:
                rec["_html"] = zlib.compress(raw.encode())
            if self.cfg.html_validation:
                rec.update(validate_html(raw))
            rec["val_over_2mb"] = size > 2 * 1024 * 1024
            source = raw
            snippets = self._snippets_for(ctype)
            if self.cfg.render_js or snippets or self.cfg.accessibility:
                try:
                    html, results, info = await self._browse(url, snippets, self.cfg.render_js)
                    if "axe" in info:
                        store_axe(rec, info["axe"])
                    self._store_js(rec, results)
                    if self.cfg.render_js:
                        rec["js_errors"] = len(info["errors"])
                        rec["js_error_msgs"] = " | ".join(dict.fromkeys(info["errors"]))[:2000]
                        final = self.norm(info.get("final_url") or "") or ""
                        if final and final != url:
                            rec["js_redirect"] = final
                            self._add_link(url, final, "", "redirect", False, depth)
                            html = None  # the browser left the page: keep this URL's own HTML
                    if html is not None:
                        source = html
                        if self.cfg.store_rendered:
                            rec["_rendered"] = zlib.compress(source.encode())
                except Exception as e:
                    rec["render_error"] = f"{type(e).__name__}: {e}"[:200]
            self._parse(rec, BeautifulSoup(source, "lxml"), source, depth)
            if rec["js_redirect"] and rec["js_redirect"] == rec["meta_refresh_url"]:
                rec["js_redirect"] = ""  # the browser followed a meta refresh, not a script
            if self.cfg.custom_search:
                text = self.text_of(rec)
                for i, cs in enumerate(self.cfg.custom_search, 1):
                    rec[f"cs{i}"] = len(cs["_re"].findall(text if cs.get("where") == "text" else source))
            if source is not raw:
                self._js_parity(rec, raw)
            rec.pop("_out_int", None)
            if rec["canonical_header"]:
                rec["canonical_mismatch"] = bool(rec["canonical"]) and rec["canonical"] != rec["canonical_header"]
                rec["canonical"] = rec["canonical"] or rec["canonical_header"]
        elif r.status_code == 200 and self._browser and (snippets := self._snippets_for(ctype)):
            try:  # e.g. image/ snippets such as alt text generation
                self._store_js(rec, (await self._browse(url, snippets, False))[1])
            except Exception as e:
                rec["render_error"] = f"{type(e).__name__}: {e}"[:200]
        directives = (rec["meta_robots"] + " " + rec["x_robots"]).lower()
        if rec["js_redirect"]:
            rec.update(indexability="Non-Indexable", indexability_reason="Redirecionado (JavaScript)")
        elif rec["meta_refresh_url"] and rec["meta_refresh_url"] != url:
            rec.update(indexability="Non-Indexable", indexability_reason="Redirecionado (meta refresh)")
        elif rec["meta_refresh_url"] and self.cfg.respect_self_meta_refresh:
            rec.update(indexability="Non-Indexable", indexability_reason="Meta refresh para a própria URL")
        elif "noindex" in directives:
            rec.update(indexability="Non-Indexable", indexability_reason="Noindex")
        elif rec["canonical"] and rec["canonical"] != url:
            rec.update(indexability="Non-Indexable", indexability_reason="Canonicalizada")
        else:
            rec["indexability"] = "Indexable"
        # Spider > Advanced: respect noindex / canonical / next-prev = keep them out of the reports
        rec["hidden"] = bool((self.cfg.respect_noindex and "noindex" in directives) or
                             (self.cfg.respect_canonical and rec["canonical"] and rec["canonical"] != url) or
                             (self.cfg.respect_next_prev and rec["pag_prev"]))
        if ctype in HTML_TYPES:
            self._apply_extraction(rec)

    def _parse(self, rec, soup, source, depth):
        url = rec["url"]
        base_tag = soup.find("base", href=True)
        base = urljoin(url, base_tag["href"]) if base_tag else url

        def meta(name, attr="name"):
            tag = soup.find("meta", attrs={attr: re.compile(f"^{re.escape(name)}$", re.I)})
            return (tag.get("content") or "").strip() if tag else ""

        head = soup.head
        outside = lambda el: head is None or not any(p is head for p in el.parents)
        titles = [t for t in soup.find_all("title") if not t.find_parent("svg")]
        rec["title_count"] = len(titles)
        rec["title_outside_head"] = any(outside(t) for t in titles)
        mds = soup.find_all("meta", attrs={"name": re.compile(r"^description$", re.I)})
        rec["md_count"] = len(mds)
        rec["md_outside_head"] = any(outside(m) for m in mds)
        rec["robots_outside_head"] = any(outside(m) for m in soup.find_all("meta", attrs={"name": re.compile(r"^(robots|googlebot)$", re.I)}))
        refresh = soup.find("meta", attrs={"http-equiv": re.compile(r"^refresh$", re.I)})
        if refresh:
            rec["meta_refresh"] = (refresh.get("content") or "").strip()[:300]
            m = re.search(r"url\s*=\s*['\"]?([^'\";]+)", rec["meta_refresh"], re.I)
            target = self._resolve(base, m.group(1).strip()) if m else None
            if target:
                rec["meta_refresh_url"] = target
                if target != url:
                    self._add_link(url, target, "", "meta_refresh", False, depth)
        title_tag = (soup.head or soup).find("title")
        rec["title"] = clean_text(title_tag.get_text(" ", strip=True)) if title_tag else ""
        rec["title_len"] = len(rec["title"])
        rec["title_px"] = pixel_width(rec["title"], 20)
        rec["meta_desc"] = meta("description")
        rec["md_len"] = len(rec["meta_desc"])
        rec["md_px"] = pixel_width(rec["meta_desc"], 14)
        rec["meta_robots"] = meta("robots")
        rec["meta_keywords"] = meta("keywords")
        rec["lang"] = soup.html.get("lang", "") if soup.html else ""

        og = {}
        for tag in soup.find_all("meta", attrs={"property": re.compile(r"^og:", re.I)}):
            og.setdefault(tag["property"].lower(), (tag.get("content") or "").strip())
        rec.update(og_title=og.get("og:title", ""), og_description=og.get("og:description", ""),
                   og_image=og.get("og:image", ""), og_type=og.get("og:type", ""),
                   twitter_card=meta("twitter:card") or meta("twitter:card", "property"))
        rec["_og"] = og

        hreflang, pag_rels = [], Counter()
        for link in soup.find_all("link", href=True):
            rels = [v.lower() for v in (link.get("rel") or [])]
            href = self._resolve(base, link["href"])
            raw_href = link["href"].strip()
            if "canonical" in rels:
                rec["canonical_count"] += 1
                rec["canonical_relative"] |= not raw_href.lower().startswith(("http://", "https://"))
                rec["canonical_fragment"] |= "#" in raw_href
                rec["canonical_outside_head"] |= head is None or not any(p is head for p in link.parents)
            if "amphtml" in rels and href and not rec["amp_url"]:
                rec["amp_url"] = href
            if "alternate" in rels and "max-width" in (link.get("media") or "").lower() and href:
                rec["mob_alternate"] = href
            pag_rels.update(r for r in rels if r in ("next", "prev"))
            if "canonical" in rels and not rec["canonical"]:
                rec["canonical"] = href or link["href"]
            elif "next" in rels and not rec["pag_next"]:
                rec["pag_next"] = href or ""
            elif "prev" in rels and not rec["pag_prev"]:
                rec["pag_prev"] = href or ""
            elif "alternate" in rels and link.get("hreflang") and href:
                hreflang.append((link["hreflang"].strip(), href))
                rec["hreflang_outside_head"] |= outside(link)
        rec["_hreflang"] = hreflang
        rec["hreflang_count"] = len(hreflang)
        rec["pag_multiple"] = any(n > 1 for n in pag_rels.values())
        # like SF's defaults, canonical / pagination / hreflang targets are crawled too
        for kind, target in ([("canonical", rec["canonical"])] if rec["canonical"].startswith("http") else []) + \
                [("pagination", rec["pag_next"]), ("pagination", rec["pag_prev"])] + [("hreflang", h) for _, h in hreflang] + \
                [("amphtml", rec["amp_url"]), ("alternate", rec["mob_alternate"])]:
            if target and target != url:
                self._add_link(url, target, "", kind, False, depth)

        vp = meta("viewport")
        low = vp.lower().replace(" ", "")
        rec["viewport"] = vp
        rec["mob_no_device_width"] = bool(vp) and "width=device-width" not in low
        ms = re.search(r"maximum-scale=(\d+(?:\.\d+)?)", low)
        rec["mob_zoom_disabled"] = bool(re.search(r"user-scalable=(no|0)\b", low)) or (ms is not None and float(ms.group(1)) < 2)
        rec["mob_plugins"] = len(soup.find_all("applet")) + sum(
            1 for el in soup.find_all(["object", "embed"])
            if re.search(r"flash|shockwave|java|silverlight|\.swf", f'{el.get("type", "")} {el.get("data", "")} {el.get("src", "")}', re.I))
        html_attrs = {k.lower() for k in (soup.html.attrs if soup.html else {})}
        rec["is_amp"] = bool(html_attrs & {"amp", "⚡"})
        if rec["is_amp"]:
            errs = []
            if not soup.find("script", src=re.compile(r"^https://cdn\.ampproject\.org/v0\.js")):
                errs.append("script do AMP (v0.js) ausente")
            if not soup.find("style", attrs={"amp-boilerplate": True}):
                errs.append("amp-boilerplate ausente")
            if not vp:
                errs.append("viewport ausente")
            if not soup.find("meta", charset=True):
                errs.append("meta charset ausente")
            if not rec["canonical"]:
                errs.append("canonical ausente")
            if any(not (s.get("src") or "").startswith("https://cdn.ampproject.org/")
                   and (s.get("type") or "").lower() not in ("application/ld+json", "application/json", "text/plain")
                   for s in soup.find_all("script")):
                errs.append("JavaScript personalizado")
            if any(not img.find_parent("noscript") for img in soup.find_all("img")):
                errs.append("<img> em vez de <amp-img>")
            if any(not ({"amp-custom", "amp-boilerplate"} & set(s.attrs)) for s in soup.find_all("style")):
                errs.append("<style> sem amp-custom")
            rec["amp_errors"] = ", ".join(errs)

        sd, types, errors, warnings, error_msgs = [], [], 0, [], []
        vocab = schema_vocab()
        validate = self.cfg.sd_schema_validation or self.cfg.sd_google_validation
        for script in (soup.find_all("script", type=re.compile(r"ld\+json", re.I)) if self.cfg.extract_jsonld else []):
            raw = script.string or script.get_text() or ""
            try:
                data = json.loads(raw)
            except ValueError as e:
                errors += 1
                error_msgs.append(f"JSON-LD inválido: {e}")
                sd.append(dict(format="JSON-LD", types=[], missing=[], warnings=[], entities=[], error=str(e), raw=raw[:5000]))
                continue
            ents = list(walk_jsonld(data))
            ent_types = [t for n in ents for t in _types(n)]
            entities = []
            for n in ents:
                e, w = validate_entity(n, vocab) if validate else ([], [])
                entities.append(dict(type="/".join(_types(n)), errors=e, warnings=w))
                errors += len(e)
                error_msgs += e
                warnings += w
            types += ent_types
            sd.append(dict(format="JSON-LD", types=ent_types, missing=[x for en in entities for x in en["errors"]],
                           warnings=[x for en in entities for x in en["warnings"]], entities=entities, error="", raw=raw[:5000]))
        rdfa = [t.rsplit("/", 1)[-1].split(":")[-1] for el in soup.find_all(attrs={"typeof": True})
                for t in (el.get("typeof") or "").split() if t]
        if rdfa and self.cfg.extract_rdfa:
            types += rdfa
            sd.append(dict(format="RDFa", types=rdfa, missing=[], error="", raw=""))
        micro = [t.rstrip("/").rsplit("/", 1)[-1] for t in
                 (el.get("itemtype") for el in soup.find_all(attrs={"itemtype": True})) if t]
        if micro and self.cfg.extract_microdata:
            types += micro
            sd.append(dict(format="Microdata", types=micro, missing=[], error="", raw=""))
        rec["sd_formats"] = ", ".join(dict.fromkeys(x["format"] for x in sd))
        rec["sd_parse_error"] = any(x.get("error") for x in sd)
        rec.update(sd_types=", ".join(dict.fromkeys(map(str, types))), sd_errors=errors,
                   sd_warnings="; ".join(dict.fromkeys(warnings))[:2000],
                   sd_error_msgs="; ".join(dict.fromkeys(error_msgs))[:2000])
        rec["_sd"] = sd

        h1_tags = soup.find_all("h1")
        h1 = [clean_text(h.get_text(" ", strip=True)) for h in h1_tags]
        h2 = [clean_text(h.get_text(" ", strip=True)) for h in soup.find_all("h2")]
        rec["h1_img_alt"] = any((img.get("alt") or "").strip() for h in h1_tags for img in h.find_all("img"))
        levels = [int(h.name[1]) for h in soup.find_all(re.compile(r"^h[1-6]$"))]
        rec["h1_nonseq"] = 1 in levels and levels[0] != 1
        if 2 in levels:
            i2 = levels.index(2)
            rec["h2_nonseq"] = 1 not in levels or levels.index(1) > i2 or any(l > 2 for l in levels[levels.index(1):i2])
        rec["h2_len"] = len(h2[0]) if h2 else 0
        rec.update(
            h1_1=h1[0] if h1 else "", h1_2=h1[1] if len(h1) > 1 else "",
            h1_count=len(h1), h1_len=len(h1[0]) if h1 else 0,
            h2_1=h2[0] if h2 else "", h2_2=h2[1] if len(h2) > 1 else "", h2_count=len(h2),
        )

        if url.startswith("https:"):
            mixed = []
            for tag, attr in MIXED_TAGS.items():
                for el in soup.find_all(tag):
                    v = (el.get(attr) or "").strip()
                    if v.lower().startswith("http://") and (tag != "link" or "stylesheet" in (el.get("rel") or [])):
                        mixed.append(v)
            rec["mixed_content"] = len(mixed)
            rec["_mixed"] = mixed

        forms = soup.find_all("form")
        rec["forms"] = len(forms)
        rec["form_on_http"] = bool(forms) and url.startswith("http:")
        rec["form_insecure"] = url.startswith("https:") and any(
            (self._resolve(base, f.get("action")) or "").startswith("http:") for f in forms if f.get("action"))
        rec["protocol_relative"] = sum(1 for tag, attr in (("script", "src"), ("link", "href"), ("img", "src"), ("iframe", "src"))
                                       for el in soup.find_all(tag) if (el.get(attr) or "").strip().startswith("//"))
        count = missing = 0
        for img in soup.find_all("img"):
            src = self._resolve(base, img.get("src") or img.get("data-src") or img.get("data-lazy-src"))
            if not src:
                continue
            alt = img.get("alt")
            count += 1
            missing += alt is None or not alt.strip()
            srcs = [src]
            if self.cfg.img_srcset:
                for cand in (img.get("srcset") or "").split(","):
                    s2 = self._resolve(base, cand.strip().split(" ")[0]) if cand.strip() else None
                    if s2 and s2 not in srcs:
                        srcs.append(s2)
            if not self.cfg.store_images and not self.cfg.check_images:
                continue
            for src in srcs:
                self._img_ref(url, src, alt, img, depth)
        rec["images"] = count
        rec["images_missing_alt"] = missing

        if self.cfg.crawl_resources:
            for tag, attr, rel in RESOURCE_TAGS:
                for el in soup.find_all(tag):
                    if rel and rel not in [v.lower() for v in (el.get("rel") or [])]:
                        continue
                    dst = self._resolve(base, el.get(attr))
                    if dst:
                        self._add_link(url, dst, "", "iframe" if tag == "iframe" else "resource", False, depth,
                                       cat=TAG_CAT.get((tag, rel)), path_type=path_type(el.get(attr)), link_path=link_xpath(el))

        if self.cfg.render_js:
            self._page_links.setdefault(url, [])
        page_nofollow = "nofollow" in rec["meta_robots"].lower()
        out_int, out_ext = set(), set()
        rec["_ids"] = {el["id"] for el in soup.find_all(id=True)} | {el["name"] for el in soup.find_all("a", attrs={"name": True})}
        frags, unsafe = [], 0
        for a in soup.find_all("a", href=True):
            dst = self._resolve(base, a["href"])
            if not dst:
                continue
            rel = [v.lower() for v in (a.get("rel") or [])]
            if (a.get("target") or "").lower() == "_blank" and not self.is_internal(dst) and \
                    "noopener" not in rel and "noreferrer" not in rel:
                unsafe += 1
            frag = urlparse(a["href"].strip()).fragment
            if frag and self.is_internal(dst) and not frag.startswith(("!", "/", ":~:")) and frag.lower() != "top":
                frags.append((dst, frag))
            nofollow = page_nofollow or "nofollow" in [v.lower() for v in (a.get("rel") or [])]
            anchor = clean_text(a.get_text(" ", strip=True))
            img = a.find("img", alt=True)
            alt = img["alt"].strip()[:200] if img else ""
            if not anchor:
                anchor = alt
            self._add_link(url, dst, anchor, "a", nofollow, depth, self._link_position(a), alt=alt,
                           target=(a.get("target") or "")[:30], rel=" ".join(a.get("rel") or [])[:60],
                           path_type=path_type(a["href"]), link_path=link_xpath(a))
            (out_int if self.is_internal(dst) else out_ext).add(dst)
        unc_int = set()
        for el, dst, how in self._uncrawlable(soup, base):
            internal = self.is_internal(dst)
            if internal:
                unc_int.add(dst)
            if self.cfg.store_uncrawlable:
                self.links.append(dict(src=url, dst=dst, anchor=clean_text(el.get_text(" ", strip=True))[:200], kind="uncrawlable",
                                       nofollow=False, internal=internal, position=self._link_position(el), via=how))
        rec["uncrawlable_outlinks"] = len(unc_int)
        rec["outlinks"] = len(out_int)
        rec["external_outlinks"] = len(out_ext)
        rec["_out_int"] = out_int
        rec["unsafe_cross_origin"] = unsafe
        rec["_frags"] = frags[:500]

        for i, ex in enumerate(self.cfg.extractors, 1):
            rec[f"ex{i}"] = self._extract(ex, soup, source)

        text = self._content_text(soup)
        rec["text_ratio"] = round(len(text) / max(1, len(source)) * 100, 1)
        rec["word_count"] = len(re.findall(r"\w+", text))
        rec["content_hash"] = zlib.crc32(text.lower().encode()) if text else ""
        rec["_text"] = zlib.compress(text[:100000].encode())
        rec["_minhash"] = minhash(text)
        rec["sentences"] = sentence_count(soup, self._content_text_blocks) if rec["word_count"] else 0
        rec["avg_wps"] = round(rec["word_count"] / rec["sentences"], 2) if rec["sentences"] else None
        rec["flesch"] = flesch(text, rec["lang"], rec["sentences"])
        rec["lorem_ipsum"] = "lorem ipsum" in text.lower()
        phrases = [x.strip().lower() for x in self.cfg.soft404_phrases if x.strip()]
        head_txt, low_txt = (rec["title"] + " " + rec["h1_1"]).lower(), text.lower()
        rec["soft_404"] = any(x in head_txt for x in phrases) or (rec["word_count"] < 150 and any(x in low_txt for x in phrases))

    def _parse_pdf(self, rec, body, depth):
        """Title, page count, word count and links from a PDF (SF 'How To Audit PDFs')."""
        try:
            import io
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(body))
            meta = reader.metadata or {}
            rec["title"] = str(meta.get("/Title") or "").strip()
            rec["title_len"] = len(rec["title"])
            rec["pdf_pages"] = len(reader.pages)
            text, links = [], []
            for page in reader.pages[:200]:
                try:
                    text.append(page.extract_text() or "")
                except Exception:
                    pass
                for annot in page.get("/Annots") or []:
                    try:
                        uri = annot.get_object().get("/A", {}).get("/URI")
                    except Exception:
                        uri = None
                    if uri:
                        links.append(str(uri))
            words = re.findall(r"\w+", " ".join(text))
            rec["word_count"] = len(words)
            out_int, out_ext = set(), set()
            for u in dict.fromkeys(links):
                dst = self._resolve(rec["url"], u)
                if dst:
                    self._add_link(rec["url"], dst, "", "a", False, depth, "PDF")
                    (out_int if self.is_internal(dst) else out_ext).add(dst)
            rec["outlinks"], rec["external_outlinks"] = len(out_int), len(out_ext)
        except Exception as e:
            rec["render_error"] = f"PDF: {type(e).__name__}: {e}"[:200]

    def _js_parity(self, rec, raw):
        """Compare the raw HTML with the rendered DOM (SF JavaScript tab)."""
        soup = BeautifulSoup(raw, "lxml")
        base_tag = soup.find("base", href=True)
        base = urljoin(rec["url"], base_tag["href"]) if base_tag else rec["url"]
        t = (soup.head or soup).find("title")
        title = clean_text(t.get_text(" ", strip=True)) if t else ""
        md = soup.find("meta", attrs={"name": re.compile("^description$", re.I)})
        robots = soup.find("meta", attrs={"name": re.compile("^robots$", re.I)})
        h1 = soup.find("h1")
        canon = ""
        for link in soup.find_all("link", href=True):
            if "canonical" in [v.lower() for v in (link.get("rel") or [])]:
                canon = self._resolve(base, link["href"]) or link["href"]
                break
        raw_all = {d for a in soup.find_all("a", href=True) if (d := self._resolve(base, a["href"]))}
        raw_links = {d for d in raw_all if self.is_internal(d)}
        for l in self._page_links.pop(rec["url"], []):   # Link Origin
            if l["kind"] == "a":
                l["origin"] = "HTML e HTML renderizado" if l["dst"] in raw_all else "HTML renderizado"
        # JS parity: compare the same extraction (content area) on raw vs rendered HTML.
        # A soup copy is used because _content_text() mutates the tree.
        raw_soup = BeautifulSoup(raw, "lxml")
        try:
            raw_text = self._content_text(raw_soup)
        except Exception:
            raw_text = " ".join((raw_soup.body or raw_soup).get_text(" ").split())
        raw_words = len(re.findall(r"\w+", raw_text))
        rendered = rec["word_count"] or 0
        rec.update(
            js_raw_words=raw_words,
            js_word_diff_pct=round((rendered - raw_words) / rendered * 100, 1) if rendered else 0,
            js_links_only_rendered=len(set(rec.get("_out_int") or ()) - raw_links),
            js_title_changed=title != rec["title"],
            js_meta_changed=((md.get("content") or "").strip() if md else "") != rec["meta_desc"],
            js_h1_changed=(clean_text(h1.get_text(" ", strip=True)) if h1 else "") != rec["h1_1"],
            js_canonical_changed=canon != rec["canonical"],
            js_noindex_only_rendered="noindex" in rec["meta_robots"].lower()
                                     and "noindex" not in ((robots.get("content") or "").lower() if robots else ""),
        )

    @staticmethod
    def _extract(ex, soup, source):
        try:
            kind, expr, attr = ex.get("type"), ex.get("expr", ""), (ex.get("attr") or "").strip()
            if kind == "css":
                vals = [(el.get(attr) or "") if attr else el.get_text(" ", strip=True) for el in soup.select(expr)]
            elif kind == "xpath":
                from lxml import html as lxml_html
                vals = []
                for v in lxml_html.fromstring(source).xpath(expr):
                    if isinstance(v, str):
                        vals.append(v.strip())
                    elif attr:
                        vals.append(v.get(attr, ""))
                    else:
                        vals.append(" ".join(v.text_content().split()))
            else:
                vals = [m if isinstance(m, str) else next((g for g in m if g), "") for m in ex["_re"].findall(source)]
            return " | ".join(v for v in (clean_text(x) for x in vals[:10]) if v)
        except Exception as e:
            return f"[erro: {e}]"

    async def _check_resources(self, items):
        sem = asyncio.Semaphore(self.cfg.concurrency)

        async def check(rec):
            async with sem:
                if self._stop:
                    return
                if self.cfg.respect_robots and items is self.external:
                    rp = await self._robots_for(rec["url"])
                    if rp:
                        allowed, line, _ = rp.check(rec["url"], self.cfg.robots_ua or self.cfg.user_agent)
                        if not allowed:
                            rec.update(status=0, status_text="Bloqueado pelo robots.txt", robots_line=line or "")
                            if not self.cfg.show_external_blocked:
                                items.pop(rec["url"], None)
                            return
                t0 = time.perf_counter()
                try:
                    r = await self._send("HEAD", rec["url"], follow_redirects=True)
                    if r.status_code >= 400:  # many servers reject HEAD; retry with GET
                        r = await self._send("GET", rec["url"], follow_redirects=True)
                        size = len(r.content)
                    else:
                        cl = r.headers.get("content-length", "")
                        size = int(cl) if cl.isdigit() else None
                    rec.update(status=r.status_code, status_text=r.reason_phrase, size=size,
                               content_type=r.headers.get("content-type", "").split(";")[0].strip().lower(),
                               response_ms=round((time.perf_counter() - t0) * 1000))
                except Exception as e:
                    rec.update(status=0, status_text="URL malformada" if isinstance(e, httpx.UnsupportedProtocol) else f"{type(e).__name__}: {e}"[:200])

        await asyncio.gather(*(check(r) for r in list(items.values())))

    # ---------- analysis ----------
    def finalize(self, groups=None):
        """SF 'Crawl Analysis': calculations that need the whole crawl (link score, near duplicates,
        sitemaps, orphans, pagination, hreflang…). Runs at the end of the crawl or from the menu."""
        groups = [g for g in (self.cfg.analysis if groups is None else groups) if g in ANALYSIS_GROUPS]
        steps = 1 + ("link_score" in groups) + ("content" in groups) + bool(self.cfg.spelling)
        self.analysis.update(running=True, done=0, total=steps, stop=False, stopped=False)

        def checkpoint():   # Crawl Analysis > Stop
            if self.analysis.get("stop"):
                raise _AnalysisStopped()
        try:
            html_pages = [p for p in list(self.pages.values()) if is_html(p)]
            if "link_score" in groups:
                edges = [(l["src"], l["dst"]) for l in self.links if l["kind"] == "a" and not l["nofollow"]]
                scores = link_score([p["url"] for p in html_pages], edges)
                for p in html_pages:
                    p["link_score"] = scores.get(p["url"])
                self.analysis["done"] += 1
            checkpoint()
            if "content" in groups:
                items = [(p["url"], p["_minhash"]) for p in html_pages
                         if p.get("_minhash") is not None and (not self.cfg.dup_indexable_only or p["indexability"] == "Indexable")
                         and not (self.cfg.ignore_paginated_dups and p["pag_prev"])] if self.cfg.near_dups else []
                nd = near_duplicates(items, self.cfg.near_dup_threshold) if items else {}
                for p in html_pages:
                    lst = nd.get(p["url"], [])
                    p["near_dup_count"] = len(lst)
                    p["closest_similarity"] = lst[0][1] if lst else None
                self.near_dups = nd
                if self.cfg.semantic:
                    self._semantic(html_pages)
                self.analysis["done"] += 1
            checkpoint()
            if self.cfg.spelling:
                self._spellcheck(html_pages)
                self.analysis["done"] += 1
            checkpoint()
            self.analysed = set(groups)
            self.analyze()
            self.analysis["done"] += 1
            self.finalized = True
        except _AnalysisStopped:
            self.analysis["stopped"] = True
        finally:
            self.analysis["running"] = False
            self.analysis["stop"] = False

    def text_of(self, p):
        return zlib.decompress(p["_text"]).decode() if p.get("_text") else ""

    def lang_of(self, p):
        if self.cfg.spell_lang != "auto":
            return self.cfg.spell_lang
        lang = (p.get("lang") or "")[:2].lower()
        return lang if lang in SPELL_LANGS else "en"

    def _spellcheck(self, html_pages):
        ignore = {w.strip().lower() for w in list(self.cfg.spell_ignore) + list(self.cfg.spell_dictionary) if w.strip()}
        try:
            for p in html_pages:
                if p.get("_text"):
                    lang = self.lang_of(p)
                    bad = misspelled(self.text_of(p), lang, ignore)
                    p.update(_spelling=bad[:300], spelling_errors=len(bad), spell_lang=lang)
        except ImportError:
            pass

    def _semantic(self, html_pages):
        if (self.semantic or {}).get("embedder"):
            return  # keep the AI embeddings index (better than the local TF-IDF one)
        pages = [p for p in html_pages if p.get("_text") and self._embeddable(p)]
        if len(pages) < 3:
            return
        self._semantic_from(pages, semantic_index([self.text_of(p) for p in pages]))

    def _embeddable(self, p):
        """Content > Embeddings: filter rules + indexable / paginated options."""
        for exclude, rx in self._embed_rules:
            if rx.search(p["url"]):
                return not exclude
        if self._embed_rules and any(not ex for ex, _ in self._embed_rules):
            return False  # include rules given and none matched
        idx_only = self.cfg.semantic_indexable_only or self.cfg.low_relevance_indexable_only
        return not (idx_only and p["indexability"] != "Indexable")

    def apply_embeddings(self, key, embedder):
        """Rebuild semantic similarity / relevance / search from AI embeddings (SF: Embeddings prompts)."""
        import numpy as np
        pages = [p for p in list(self.pages.values()) if is_html(p) and (p.get("_emb") or {}).get(key)]
        if len(pages) < 3:
            return
        E = np.array([p["_emb"][key] for p in pages], dtype=np.float32)
        E /= np.maximum(np.linalg.norm(E, axis=1, keepdims=True), 1e-9)
        self._semantic_from(pages, {"E": E, "vocab": None, "Vt": None, "idf": None}, embedder)
        self.semantic["key"] = key

    def _semantic_from(self, pages, index, embedder=None):
        E = index["E"]
        urls = [p["url"] for p in pages]
        pairs = semantic_pairs(E, self.cfg.semantic_threshold)
        centroid = E.mean(axis=0)
        centroid /= max(float((centroid ** 2).sum()) ** 0.5, 1e-9)
        rel = E @ centroid
        cutoff = self.cfg.low_relevance_threshold or min(float(rel.mean() - 2 * rel.std()), 0.2)
        related = {}
        for p, (count, best, score, top), r in zip(pages, pairs, rel):
            sim_ok = self.cfg.semantic_similarity and (p["indexability"] == "Indexable" or not self.cfg.semantic_indexable_only) \
                and not (self.cfg.semantic_ignore_paginated and p["pag_prev"])
            low_ok = self.cfg.low_relevance_on and (p["indexability"] == "Indexable" or not self.cfg.low_relevance_indexable_only) \
                and not (self.cfg.low_relevance_ignore_paginated and p["pag_prev"])
            p.update(semantic_similar=count if sim_ok else 0, semantic_closest=urls[best], semantic_max=round(score, 3),
                     semantic_relevance=round(float(r), 3), low_relevance=bool(low_ok and r < cutoff))
            related[p["url"]] = [(urls[j], round(s, 3)) for j, s in top]
        self.semantic = {"index": index, "urls": urls, "related": related, "embedder": embedder}

    def semantic_search(self, query, limit=50, vector=None):
        if not self.semantic:
            return []
        if vector is not None:
            import numpy as np
            q = np.asarray(vector, dtype=np.float32)
            q /= max(float(np.linalg.norm(q)), 1e-9)
        else:
            q = semantic_embed(self.semantic["index"], query)
        scores = self.semantic["index"]["E"] @ q
        order = scores.argsort()[::-1][:limit]
        return [dict(url=self.semantic["urls"][i], score=round(float(scores[i]), 3)) for i in order if scores[i] > 0]

    def redirect_chain(self, url):
        chain, seen = [url], {url}
        cur = self.pages.get(url)
        while cur and cur.get("redirect_url") and len(chain) <= 20:
            nxt = cur["redirect_url"]
            if nxt in seen:
                return chain + [nxt], True
            chain.append(nxt)
            seen.add(nxt)
            cur = self.pages.get(nxt)
        return chain, False

    def _status_of(self, url):
        r = self.pages.get(url) or self.external.get(url)
        return r["status"] if r else None

    def analyze(self):
        on = self.analysed.__contains__
        PREFS.clear()
        PREFS.update(DEFAULT_PREFS)
        for k, v in (self.cfg.prefs or {}).items():
            if k in DEFAULT_PREFS and v not in (None, ""):
                try:
                    PREFS[k] = float(v)
                except (TypeError, ValueError):
                    pass
        weak = {w.strip().lower() for w in self.cfg.weak_anchors if w.strip()}
        pages = [p for p in list(self.pages.values()) if not p.get("hidden")]
        externals = list(self.external.values())
        images = list(self.images.values())

        inl, inl_all = defaultdict(set), Counter()
        nofollow_out, weak_out = Counter(), Counter()
        content_in, anchors_in, a_out = defaultdict(set), defaultdict(Counter), defaultdict(set)
        hsts_out = Counter()
        for l in self.links:
            if l["kind"] != "redirect":
                inl[l["dst"]].add(l["src"])
                inl_all[l["dst"]] += 1
            if l["kind"] == "a" and l["internal"]:
                a_out[l["src"]].add(l["dst"])
                if l.get("position") in ("Conteúdo", "PDF"):
                    content_in[l["dst"]].add(l["src"])
                if l["anchor"].strip():
                    anchors_in[l["dst"]][l["anchor"].strip()] += 1
                if l["dst"].startswith("http:") and urlparse(l["dst"]).hostname in self.hsts_hosts:
                    hsts_out[l["src"]] += 1
            if l["kind"] == "a" and l["internal"]:
                nofollow_out[l["src"]] += l["nofollow"]
                weak_out[l["src"]] += l["anchor"].strip().lower() in weak
        noanchor_out, in_follow, in_nofollow, in_src = Counter(), defaultdict(set), defaultdict(set), defaultdict(set)
        res_dst = set()
        for l in self.links:
            if l["kind"] == "a" and l["internal"]:
                noanchor_out[l["src"]] += not l["anchor"].strip()
                (in_nofollow if l["nofollow"] else in_follow)[l["dst"]].add(l["src"])
                in_src[l["dst"]].add(l["src"])
            elif l["kind"] in ("resource", "iframe"):
                res_dst.add(l["dst"])
        found_on, missing_alt = defaultdict(set), defaultdict(set)
        alt_attr, alt_long, unsized = defaultdict(set), defaultdict(set), defaultdict(set)
        for ref in self.image_refs:
            res_dst.add(ref["src"])
            if ref["alt"] is None:
                alt_attr[ref["src"]].add(ref["page"])
            elif len(ref["alt"]) > PREFS["alt_max"]:
                alt_long[ref["src"]].add(ref["page"])
            if not ref.get("sized", True):
                unsized[ref["src"]].add(ref["page"])
            found_on[ref["src"]].add(ref["page"])
            inl[ref["src"]].add(ref["page"])
            inl_all[ref["src"]] += 1
            if ref["alt"] is None or not ref["alt"].strip():
                missing_alt[ref["src"]].add(ref["page"])
        for r in pages + externals + images:
            r["unique_inlinks"] = len(inl.get(r["url"], ()))
            r["inlinks"] = inl_all.get(r["url"], 0)
        for r in pages + images:
            r["found_on"] = len(found_on.get(r["url"], ()))
            r["missing_alt"] = len(missing_alt.get(r["url"], ()))
            r["missing_alt_attr"] = len(alt_attr.get(r["url"], ()))
            r["alt_long"] = len(alt_long.get(r["url"], ()))
            r["missing_size"] = len(unsized.get(r["url"], ()))
        blocked_dst = {p["url"] for p in pages if p["status"] == 0 and p["status_text"].startswith("Bloqueado")}
        blocked_out = Counter()
        for l in self.links:
            if l["kind"] in ("resource", "iframe") and l["dst"] in blocked_dst:
                blocked_out[l["src"]] += 1
        for ref in self.image_refs:
            if ref["src"] in blocked_dst:
                blocked_out[ref["page"]] += 1
        for p in pages:
            p["blocked_resource"] = p["url"] in blocked_dst and p["url"] in res_dst
            p["blocked_resources"] = blocked_out.get(p["url"], 0)
            p["noanchor_outlinks"] = noanchor_out.get(p["url"], 0)
            if on("links"):
                f, nf = in_follow.get(p["url"], ()), in_nofollow.get(p["url"], ())
                p["mixed_inlinks"] = bool(f) and bool(nf)
                p["nofollow_only_inlinks"] = bool(nf) and not f
                srcs = in_src.get(p["url"], ())
                p["nonidx_inlinks_only"] = bool(srcs) and p["depth"] != 0 and all(
                    (self.pages.get(s) or {}).get("indexability") == "Non-Indexable" for s in srcs)
            if on("sitemaps"):
                p["sitemap_multi"] = self.sitemap_hits.get(p["url"], 0) > 1
            bad = 0
            for dst, frag in p.get("_frags") or ():
                t = self.pages.get(dst)
                if t is not None and is_html(t) and "_ids" in t and frag not in t["_ids"]:
                    bad += 1
            p["broken_bookmarks"] = bad
        for p in pages:
            p["nofollow_outlinks"] = nofollow_out.get(p["url"], 0)
            p["weak_anchors"] = weak_out.get(p["url"], 0)
            p["content_inlinks"] = len(content_in.get(p["url"], ()))
            anc = anchors_in.get(p["url"])
            p["unique_anchors"] = len(anc) if anc else 0
            p["top_anchors"] = "; ".join(f"{a} ({n})" for a, n in anc.most_common(5)) if anc else ""
            p["hsts_http_links"] = hsts_out.get(p["url"], 0)
        images = images + [p for p in pages if p["content_type"].startswith("image/") or (not p["content_type"] and IMG_EXT_RE.search(p["url"]))]

        broken = {r["url"] for r in pages + externals if is_broken(r)}
        out_broken = defaultdict(set)
        for l in self.links:
            if l["kind"] == "a" and l["dst"] in broken:
                out_broken[l["src"]].add(l["dst"])

        has_sitemap = bool(self.sitemap_urls)
        for p in pages:
            p["broken_outlinks"] = len(out_broken.get(p["url"], ()))
            if p["redirect_url"] and on("response_codes"):
                chain, loop = self.redirect_chain(p["url"])
                p.update(redirect_hops=len(chain) - 1, redirect_final=chain[-1], redirect_loop=loop,
                         redirect_final_status=None if loop else self._status_of(chain[-1]))
            src_on = {"sitemap": on("sitemaps"), "ga4": on("analytics"), "gsc": on("search_console")}
            p["orphan"] = src_on.get(p["found_via"], False) and p["unique_inlinks"] == 0
            p["in_ga"] = (p.get("ga_sessions") or 0) > 0 or p["found_via"] == "ga4"
            p["in_gsc"] = (p.get("gsc_impressions") or 0) > 0 or p["found_via"] == "gsc"
            p["not_in_sitemap"] = (on("sitemaps") and has_sitemap and is_html(p) and p["indexability"] == "Indexable"
                                   and not p["in_sitemap"])

        html_pages = [p for p in pages if is_html(p)]
        self._check_canonicals_pagination(html_pages, a_out, on("canonicals"), on("pagination"))
        dup_pool = [p for p in html_pages if (not self.cfg.dup_indexable_only or p["indexability"] == "Indexable")
                    and not (self.cfg.ignore_paginated_dups and p["pag_prev"])]
        dup_set = {id(p) for p in dup_pool}
        for field_ in ("title", "meta_desc", "h1_1", "h2_1", "content_hash"):
            key = lambda p: str(p[field_]).strip().lower()
            counts = Counter(key(p) for p in dup_pool if p[field_] != "")
            for p in html_pages:
                p[field_ + "_dup"] = id(p) in dup_set and p[field_] != "" and counts[key(p)] > 1

        for p in html_pages:
            if p["amp_url"]:
                st_ = self._status_of(p["amp_url"])
                p["amp_non200"] = st_ is not None and st_ != 200
            if p["is_amp"]:
                canon = self.pages.get(p["canonical"]) if p["canonical"] and p["canonical"] != p["url"] else None
                p["amp_no_return"] = canon is not None and is_html(canon) and canon.get("amp_url") != p["url"]
        hl_map = {p["url"]: {h for _, h in p.get("_hreflang") or []} for p in html_pages}
        a_dst = {d for s in a_out.values() for d in s}
        for p in html_pages:
            hl = p.get("_hreflang") or []
            issues = set()
            if hl:
                if any(not LANG_RE.match(lang) for lang, _ in hl):
                    issues.add("código inválido")
                if p["url"] not in hl_map[p["url"]]:
                    issues.add("sem autorreferência")
                for _, href in (hl if on("hreflang") else ()):
                    st = self._status_of(href)
                    if st is not None and st != 200:
                        issues.add("destino não-200")
                    if href in hl_map and href != p["url"] and p["url"] not in hl_map[href]:
                        issues.add("sem retorno")
                    t = self.pages.get(href)
                    if t is not None and is_html(t):
                        if t["canonical"] and t["canonical"] != href:
                            issues.add("destino não canônico")
                        if t["indexability_reason"] == "Noindex":
                            issues.add("destino noindex")
                    if href != p["url"] and href not in a_dst:
                        issues.add("URL sem link interno")
                langs = Counter(lang.lower() for lang, _ in hl)
                if any(n > 1 and len({h for l2, h in hl if l2.lower() == lang}) > 1 for lang, n in langs.items()):
                    issues.add("entradas múltiplas")
                if "x-default" not in langs:
                    issues.add("sem x-default")
            p["hreflang_issues"] = ", ".join(sorted(issues))

        scopes = {"page": pages, "html": html_pages, "external": externals, "image": images}
        for p in pages:
            p["issues"] = []
        issues = []
        off = [prefix for prefix, key in EXTRACT_RULES if not getattr(self.cfg, key, True)]
        if not (self.cfg.extract_jsonld or self.cfg.extract_microdata or self.cfg.extract_rdfa):
            off += ["Dados estruturados", "Sem dados estruturados"]
        for name_t, typ, prio, scope, pred in ISSUE_RULES:
            name = name_t.format(**PREFS) if "{" in name_t else name_t
            group = ISSUE_GROUPS.get(name)
            if any(name.startswith(x) for x in off):
                continue
            if group and not on(group):
                issues.append(dict(name=name, type=typ, priority=prio, count=0, urls=[], pending=group))
                continue
            hits = [r for r in scopes[scope] if r["status"] is not None and pred(r)]
            if self.cfg.ignore_nonindexable_issues and scope == "html" and name.startswith(NONIDX_PREFIXES):
                hits = [r for r in hits if r["indexability"] != "Non-Indexable"]
            if scope in ("page", "html"):
                for r in hits:
                    r["issues"].append(name)
            issues.append(dict(name=name, type=typ, priority=prio, count=len(hits),
                               urls=[r["url"] for r in hits]))
        for name, pred in (("Sitemaps: sitemap XML com mais de 50 mil URLs", lambda s: s["urls"] > 50000),
                           ("Sitemaps: sitemap XML acima de 50 MB", lambda s: s["size"] > 50 * 1024 * 1024)):
            hits = [s["url"] for s in self.sitemap_info if pred(s)]
            issues.append(dict(name=name, type="Issue", priority="Alta", count=len(hits), urls=hits))
        return issues

    def _check_canonicals_pagination(self, html_pages, a_out, canonicals=True, pagination=True):
        def bad_target(u):
            t = self.pages.get(u)
            return t is not None and t["status"] is not None and (t["status"] != 200 or t["indexability"] == "Non-Indexable")

        linked = {d for s in a_out.values() for d in s}
        for p in html_pages:
            c = p["canonical"]
            if canonicals:
                p["canonical_nonindexable"] = bool(c) and c != p["url"] and bad_target(c)
                p["canonical_unlinked"] = bool(c) and c != p["url"] and c not in linked
            if not pagination:
                continue
            nxt, prv = p["pag_next"], p["pag_prev"]
            targets = [u for u in (nxt, prv) if u]
            p["pag_non200"] = any((self.pages.get(u) or {}).get("status") not in (None, 200) for u in targets)
            p["pag_nonindexable"] = any((self.pages.get(u) or {}).get("indexability") == "Non-Indexable" for u in targets)
            p["pag_unlinked"] = any(u not in a_out.get(p["url"], ()) for u in targets)
            nt = self.pages.get(nxt) if nxt else None
            p["pag_sequence_error"] = bool(nt and is_html(nt) and nt["pag_prev"] and nt["pag_prev"] != p["url"])
            seen, cur, loop = {p["url"]}, nxt, False
            while cur and len(seen) < 500:
                if cur in seen:
                    loop = True
                    break
                seen.add(cur)
                cur = (self.pages.get(cur) or {}).get("pag_next")
            p["pag_loop"] = loop

    def why_not(self, url):
        """Explain why a URL is or isn't in the crawl (SF 'How To Debug Missing Pages')."""
        u = self.norm(url) or url
        if u in self.pages:
            p = self.pages[u]
            return dict(url=u, crawled=True, status=p["status"], status_text=p["status_text"],
                        robots_line=p.get("robots_line", ""), indexability=p["indexability"],
                        reason=p["indexability_reason"], found_via=p["found_via"], parent=p["parent"])
        if u in self.external:
            return dict(url=u, crawled=False, reason="URL externa: só o status é verificado", parent="")
        if u in self.skipped:
            reason, parent = self.skipped[u]
            return dict(url=u, crawled=False, reason=reason, parent=parent)
        if u in self.sitemap_urls:
            return dict(url=u, crawled=False, reason="Só existe na sitemap e o rastreamento das sitemaps está desligado", parent="")
        if u in self.api_urls:
            return dict(url=u, crawled=False, reason="Encontrada no GA4/Search Console, mas sem links internos", parent="")
        return dict(url=u, crawled=False, parent="",
                    reason="Nenhuma página rastreada tem link para esta URL (pode ser órfã ou estar atrás de JavaScript/formulário)")

    def snapshot(self):
        issues = self.analyze()
        return dict(progress=self.progress(), pages=[public(p) for p in list(self.pages.values()) if not p.get("hidden")],
                    prefs=dict(PREFS),
                    external=list(self.external.values()), images=list(self.images.values()),
                    analysed=sorted(self.analysed), analysis_groups=list(self.cfg.analysis),
                    custom_js=[s.get("name") or f"Snippet {i}" for i, s in enumerate(self.cfg.custom_js, 1)],
                    custom_search=[dict(name=s.get("name") or f"Pesquisa {i}", mode=s.get("mode", "contains"))
                                   for i, s in enumerate(self.cfg.custom_search, 1)],
                    issues=issues, extractors=[e.get("name") or f"Extrator {i}" for i, e in
                                               enumerate(self.cfg.extractors, 1)],
                    sitemaps=self.sitemaps, finalized=self.finalized, semantic_ready=bool(self.semantic),
                    crawl=dict(id=self.crawl_id, name=self.crawl_name, project=self.project),
                    api_urls={u: sorted(v) for u, v in list(self.api_urls.items())[:5000]},
                    skipped_count=len(self.skipped), hsts_hosts=sorted(self.hsts_hosts),
                    cookies=self.cookie_rows(), a11y_rules=self.a11y_summary(),
                    a11y_error=getattr(self, "a11y_error", ""),
                    spelling_top=self._spelling_top())

    def cookie_rows(self):
        """One row per distinct cookie (SF Cookies tab): HTTP Set-Cookie headers plus the browser jar."""
        rows = {}
        for p in list(self.pages.values()):
            for ck in p.get("_cookies") or ():
                k = (ck["name"], ck["domain"])
                if k not in rows:
                    rows[k] = dict(ck, key=f"cookie:{ck['name']}@{ck['domain']}", url=p["url"], pages=0, source="HTTP")
                rows[k]["pages"] += 1
        for ck in self.browser_cookies or ():
            dom = (ck.get("domain") or "").lstrip(".")
            if (ck.get("name"), dom) in rows:
                continue
            exp = ck.get("expires")
            rows[(ck.get("name"), dom)] = dict(
                key=f"cookie:{ck.get('name')}@{dom}", url=f"{'https' if ck.get('secure') else 'http'}://{dom}{ck.get('path') or '/'}", name=ck.get("name", ""),
                domain=dom, path=ck.get("path") or "/",
                expires="Sessão" if exp in (None, -1) else time.strftime("%Y-%m-%d %H:%M", time.gmtime(exp)),
                secure=bool(ck.get("secure")), httponly=bool(ck.get("httpOnly")), samesite=ck.get("sameSite", ""),
                source="Navegador (JavaScript)", pages=None)
        for r in rows.values():
            r["third_party"] = not any(r["domain"] == h or r["domain"].endswith("." + h) for h in self.roots)
        return sorted(rows.values(), key=lambda r: (r["third_party"], r["domain"], r["name"]))

    def a11y_summary(self):
        agg = {}
        for p in list(self.pages.values()):
            for v in p.get("_a11y") or ():
                a = agg.setdefault(v["id"], dict(id=v["id"], help=v["help"], impact=v["impact"], pages=0, nodes=0))
                a["pages"] += 1
                a["nodes"] += v["nodes"]
        return sorted(agg.values(), key=lambda a: -a["pages"])

    def _spelling_top(self, limit=50):
        where = defaultdict(list)
        for p in list(self.pages.values()):
            for w in p.get("_spelling") or ():
                where[w].append(p["url"])
        top = sorted(where.items(), key=lambda kv: -len(kv[1]))[:limit]
        return [dict(word=w, count=len(urls), urls=urls[:500]) for w, urls in top]

    def links_for(self, url):
        inlinks = [dict(l, status=self._status_of(l["src"])) for l in self.links if l["dst"] == url]
        inlinks += [dict(src=r["page"], dst=url, anchor="", alt=r["alt"] or "", kind="img", nofollow=False,
                         internal=True, status=self._status_of(r["page"]))
                    for r in self.image_refs if r["src"] == url]
        outlinks = [dict(l, status=self._status_of(l["dst"])) for l in self.links if l["src"] == url]
        outlinks += [dict(src=url, dst=r["src"], anchor="", alt=r["alt"] or "", kind="img", nofollow=False,
                          internal=self.is_internal(r["src"]), status=self._status_of(r["src"]))
                     for r in self.image_refs if r["page"] == url]
        def info(src):
            rec = self.images.get(src) or self.pages.get(src) or {}
            return dict(status=rec.get("status"), size=rec.get("size"), content_type=rec.get("content_type", ""))
        imgs = [dict(r, **info(r["src"])) for r in self.image_refs if r["page"] == url]
        refs = [dict(r, **info(r["src"]), page_status=self._status_of(r["page"])) for r in self.image_refs if r["src"] == url]
        return dict(inlinks=inlinks, outlinks=outlinks, images=imgs, image_refs=refs)

    def url_detail(self, url):
        rec = self.pages.get(url) or self.external.get(url) or self.images.get(url)
        if rec is None:
            return None
        hl_back = {}
        for lang, href in rec.get("_hreflang") or []:
            target = self.pages.get(href)
            hl_back[href] = bool(target and url in {h for _, h in target.get("_hreflang") or []})
        chain, loop = self.redirect_chain(url) if rec.get("redirect_url") else ([], False)
        return dict(
            record=public(rec), headers=rec.get("_headers", {}), og=rec.get("_og", {}),
            cookies=rec.get("_cookies", []), a11y=rec.get("_a11y", []), psi_audits=rec.get("_psi_audits", []),
            structured=rec.get("_sd", []), mixed=rec.get("_mixed", []),
            hreflang=[dict(lang=l, url=h, status=self._status_of(h), returns=hl_back.get(h))
                      for l, h in rec.get("_hreflang") or []],
            chain=[dict(url=u, status=self._status_of(u)) for u in chain], loop=loop,
            near_dups=[dict(url=u, similarity=s) for u, s in self.near_dups.get(url, [])],
            exact_dups=[p["url"] for p in self.pages.values()
                        if rec.get("content_hash") and p is not rec and p.get("content_hash") == rec["content_hash"]],
            links=self.links_for(url), has_source="_html" in rec, has_rendered="_rendered" in rec,
            spelling=self._suggest(rec), grammar=rec.get("_grammar"),
            semantic=[dict(url=u, score=s) for u, s in (self.semantic or {}).get("related", {}).get(url, [])],
            extractors=[e.get("name") or f"Extrator {i}" for i, e in enumerate(self.cfg.extractors, 1)],
            custom_js=[s.get("name") or f"Snippet {i}" for i, s in enumerate(self.cfg.custom_js, 1)],
            extra=self._detail_extra(url, rec),
        )

    def _detail_extra(self, url, rec):
        """Derived values for the URL Details tab."""
        from urllib.parse import quote
        path = urlparse(url).path or "/"
        segs = [s for s in path.split("/") if s]
        folder_depth = len(segs) - (0 if path.endswith("/") or not segs else 1)
        out_int, out_ext = [], []
        for l in self.links:
            if l["src"] == url and l["kind"] == "a":
                (out_int if l["internal"] else out_ext).append(l["dst"])
        html_ok = sum(1 for p in self.pages.values() if is_html(p) and p.get("status") and 200 <= p["status"] < 300)
        canon = rec.get("canonical") or rec.get("canonical_header") or ""
        target = self.pages.get(canon) if canon else None
        return dict(
            encoded=quote(url, safe=":/?#[]@!$&'()*+,;=%~"),
            folder_depth=folder_depth if url in self.pages else None,
            outlinks=len(out_int), unique_outlinks=len(set(out_int)),
            external_outlinks=len(out_ext), unique_external_outlinks=len(set(out_ext)),
            pct_total=round((rec.get("unique_inlinks") or 0) / html_ok * 100, 1) if html_ok and url in self.pages else None,
            canonical=canon, canonical_origin=("HTML" if rec.get("canonical") else "HTTP") if canon else "",
            canonical_indexability=target.get("indexability", "") if target else "",
            readability=readability_label(rec.get("flesch")), carbon_rating=carbon_rating(rec.get("co2_mg")),
            js_unique_outlinks=rec.get("js_links_only_rendered") or 0,
        )

    def _suggest(self, rec):
        words = rec.get("_spelling")
        if not words:
            return []
        try:
            sp = speller(rec["spell_lang"])
        except Exception:
            return [dict(word=w, suggestion="") for w in words]
        return [dict(word=w, suggestion=(sp.correction(w) or "") if i < 40 and len(w) < 16 else "")
                for i, w in enumerate(words)]

    def source(self, url, rendered=False):
        rec = self.pages.get(url) or {}
        blob = rec.get("_rendered" if rendered else "_html")
        return zlib.decompress(blob).decode() if blob else None

    def ngrams(self, urls, n=2, stopwords=True, limit=500):
        """N-gram frequencies (SF lower 'N-grams' tab) over the content text of the given pages."""
        counts, pages = Counter(), Counter()
        for u in urls[:5000]:
            p = self.pages.get(u)
            if not p or not p.get("_text"):
                continue
            grams = _ngrams(self.text_of(p), n, stopwords)
            counts.update(grams)
            pages.update(set(grams))
        return [dict(phrase=g, count=c, pages=pages[g]) for g, c in counts.most_common(limit)]

    def ngram_pages(self, phrase, limit=1000):
        n = len(phrase.split())
        out = []
        for p in list(self.pages.values()):
            if p.get("_text"):
                c = _ngrams(self.text_of(p), n, False).get(phrase.lower(), 0)
                if c:
                    out.append(dict(url=p["url"], count=c))
        return sorted(out, key=lambda x: -x["count"])[:limit]

    def sitemap_urls_out(self):
        return sorted(p["url"] for p in self.pages.values()
                      if is_html(p) and p["indexability"] == "Indexable")


# ---------- Custom JavaScript snippets ----------
_JS_PRELUDE = (
    "const seoSpider = {"
    " data: (v) => v,"
    " error: (m) => { throw new Error(String(m)); },"
    " openai: (prompt, content, options) => window.__sfOpenAI(JSON.stringify({"
    "prompt: String(prompt ?? ''), content: String(content ?? ''), options: options || {}})),"
    "};\n"
)


def snippet_matches(sn, ctype):
    want = (sn.get("content_type") or "text/html").strip().lower()
    return want in ("*", "") or (ctype or "").startswith(want)


def _js_value(v):
    if v is None:
        return ""
    if isinstance(v, str):
        out = v
    elif isinstance(v, list):
        out = " | ".join(json.dumps(x, ensure_ascii=False) if isinstance(x, (dict, list)) else str(x) for x in v[:100])
    elif isinstance(v, dict):
        out = json.dumps(v, ensure_ascii=False)
    else:
        out = str(v)
    return out[:32000]


async def run_snippet(page, sn):
    """Evaluate one snippet in the page; returns (value, error). The source is compiled by the
    DevTools protocol, so it runs even where the site's CSP forbids eval()."""
    src = "async () => {\n" + _JS_PRELUDE + (sn.get("code") or "") + "\n}"
    try:
        v = await asyncio.wait_for(page.evaluate(src), timeout=float(sn.get("timeout") or 10))
        return _js_value(v), None
    except asyncio.TimeoutError:
        return "", f"tempo esgotado ({sn.get('timeout') or 10}s)"
    except Exception as e:
        msg = re.sub(r"^page\.evaluate:\s*(error:\s*)?", "", str(e).strip(), flags=re.I).splitlines()
        return "", (msg[0] if msg else type(e).__name__)[:300]


async def test_snippet(url, sn, user_agent, ai_bridge, timeout=30):
    """Run a single snippet against a URL in a throwaway browser (Custom JavaScript tester)."""
    from playwright.async_api import async_playwright

    async def bridge(payload):
        if not ai_bridge:
            raise RuntimeError("seoSpider.openai indisponível")
        return await ai_bridge(json.loads(payload))

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        try:
            ctx = await browser.new_context(user_agent=user_agent, bypass_csp=True)
            await ctx.expose_function("__sfOpenAI", bridge)
            page = await ctx.new_page()
            logs = []
            page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
            page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
            resp = await page.goto(url, wait_until="networkidle", timeout=timeout * 1000)
            ctype = ((resp.headers.get("content-type") if resp else "") or "").split(";")[0].strip().lower()
            mark = len(logs)
            value, error = await run_snippet(page, sn)
            return dict(status=resp.status if resp else None, content_type=ctype, value=value, error=error,
                        matches=snippet_matches(sn, ctype), console=logs[mark:][:200], page_console=logs[:mark][:100])
        finally:
            await browser.close()


# ---------- HTML validation (SF Validation tab) ----------
_HEAD_OK = {"title", "meta", "link", "script", "style", "base", "noscript", "template"}
_TAG_RE = re.compile(r"<\s*(/?)([a-zA-Z][a-zA-Z0-9-]*)")


def validate_html(raw):
    """Structural checks on the raw HTML: tags in <head> that make Google end the head early, etc."""
    s = re.sub(r"<!--.*?-->", "", raw, flags=re.S)
    s = re.sub(r"<(script|style|noscript|template)\b[^>]*>.*?</\1\s*>", r"<\1>", s, flags=re.S | re.I)
    tags = [(m.group(1) == "/", m.group(2).lower(), m.start()) for m in _TAG_RE.finditer(s)]
    opens = [(t, pos) for close, t, pos in tags if not close]
    heads = [pos for t, pos in opens if t == "head"]
    bodies = [pos for t, pos in opens if t == "body"]
    htmls = [pos for t, pos in opens if t == "html"]
    out = dict(val_missing_head=not heads, val_multiple_head=len(heads) > 1, val_missing_body=not bodies,
               val_multiple_body=len(bodies) > 1,
               val_body_before_html=bool(bodies and htmls and bodies[0] < htmls[0]),
               val_head_not_first=False, val_invalid_head="")
    if htmls and heads:
        first_in_html = next((t for t, pos in opens if pos > htmls[0]), None)
        out["val_head_not_first"] = first_in_html not in (None, "head")
    if heads:
        end = min([pos for close, t, pos in tags if close and t == "head" and pos > heads[0]] + bodies + [len(s)])
        bad = [t for t, pos in opens if heads[0] < pos < end and t not in _HEAD_OK and t != "head"]
        out["val_invalid_head"] = ", ".join(dict.fromkeys(bad))
    return out


# ---------- n-grams ----------
_STOP = set("""a o e é de da do das dos em no na nos nas um uma uns umas para por com sem que se ao aos à às ou mais
como mas foi são ser seu sua seus suas the and of to in is it for on with as at by an be this that are or from
el la los las y en un una por con para del al su sus es""".split())


def _ngrams(text, n, stopwords=True):
    words = re.findall(r"[^\W\d_][\w'-]*", text.lower())
    grams = Counter()
    for i in range(len(words) - n + 1):
        g = words[i:i + n]
        if stopwords and (g[0] in _STOP or g[-1] in _STOP):
            continue
        grams[" ".join(g)] += 1
    return grams


# ---------- readability (Flesch reading ease, with Portuguese / Spanish adaptations) ----------
_VOWELS = re.compile(r"[aeiouyáéíóúâêôãõàüï]+")


SENT_END_RE = re.compile(r"[.!?…]+(?=\s|$)")


def sentence_count(soup, roots=None):
    """Sentences: every text fragment is split on . ! ? … and each piece with words counts as one sentence."""
    from bs4 import Comment
    roots = roots if isinstance(roots, list) else [roots if roots is not None else soup]
    n = 0
    for root in roots:
        for s in root.find_all(string=True):
            if isinstance(s, Comment) or not s.strip() or (s.parent is not None and s.parent.name in ("script", "style", "noscript", "template", "svg")):
                continue
            n += sum(1 for part in SENT_END_RE.split(s) if re.search(r"\w", part))
    return n or None


def syllables(word):
    """Heuristic syllable count (vowel groups, silent final e/es/ed dropped)."""
    w = word.lower()
    if len(w) <= 3:
        return 1
    w = re.sub(r"(?:[^laeiouy]es|ed|[^laeiouy]e)$", "", w)
    w = re.sub(r"^y", "", w)
    return max(1, len(re.findall(r"[aeiouy]{1,2}", w)))


def flesch(text, lang="", sentences=None):
    """Flesch Reading Ease (standard formula, the same scale for every language)."""
    words = re.findall(r"\w+", text)
    if len(words) < 100:
        return None
    sentences = sentences or max(1, len(SENT_END_RE.findall(text)))
    asl, asw = len(words) / sentences, sum(syllables(w) for w in words) / len(words)
    score = 206.835 - 1.015 * asl - 84.6 * asw
    return round(min(100.0, max(0.0, score)), 2)


def readability_label(score):
    if score is None:
        return ""
    for lim, name in ((90, "Muito fácil"), (80, "Fácil"), (70, "Razoavelmente fácil"), (60, "Normal"),
                      (50, "Razoavelmente difícil"), (30, "Difícil")):
        if score >= lim:
            return name
    return "Muito difícil"


def carbon_rating(co2_mg):
    """Sustainable Web Design digital carbon rating (grams of CO2 per page view)."""
    if co2_mg is None:
        return ""
    g = co2_mg / 1000
    for lim, grade in ((0.040, "A+"), (0.079, "A"), (0.145, "B"), (0.209, "C"), (0.278, "D"), (0.359, "E")):
        if g <= lim:
            return grade
    return "F"


# ---------- cookies ----------
def parse_set_cookie(header, url):
    parts = [x.strip() for x in header.split(";")]
    name = parts[0].split("=", 1)[0].strip()
    attrs = {}
    for a in parts[1:]:
        k, _, v = a.partition("=")
        attrs[k.strip().lower()] = v.strip()
    expires = f"Max-Age={attrs['max-age']}" if attrs.get("max-age") else attrs.get("expires") or "Sessão"
    return dict(name=name, domain=(attrs.get("domain") or urlparse(url).hostname or "").lstrip("."),
                path=attrs.get("path") or "/", expires=expires, secure="secure" in attrs,
                httponly="httponly" in attrs, samesite=attrs.get("samesite", ""))


# ---------- accessibility (axe-core, the engine SF uses) ----------
AXE_VERSION = "4.10.2"
AXE_URL = f"https://cdnjs.cloudflare.com/ajax/libs/axe-core/{AXE_VERSION}/axe.min.js"
AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]


def axe_source():
    """axe-core is downloaded once from cdnjs and cached in data/."""
    path = Path(__file__).parent / "data" / f"axe-{AXE_VERSION}.min.js"
    if not path.exists():
        r = httpx.get(AXE_URL, timeout=60, follow_redirects=True)
        r.raise_for_status()
        if "axe" not in r.text[:200]:
            raise RuntimeError("download inesperado do axe-core")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(r.text, encoding="utf-8")
    return path.read_text(encoding="utf-8")


async def run_axe(page, source):
    if not source:
        return {"error": "axe-core indisponível"}
    try:
        await page.evaluate(source)
        return {"violations": await page.evaluate(
            """async (tags) => {
                const r = await axe.run(document, {runOnly: {type: 'tag', values: tags}, resultTypes: ['violations']});
                return r.violations.map(v => ({id: v.id, impact: v.impact || '', help: v.help, helpUrl: v.helpUrl,
                  tags: v.tags, nodes: v.nodes.length, targets: v.nodes.slice(0, 10).map(n => n.target.join(' '))}));
            }""", AXE_TAGS)}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"[:200]}


def store_axe(rec, res):
    if res.get("error"):
        rec["a11y_error"] = res["error"]
        return
    v = res["violations"]
    rec["_a11y"] = v
    by = Counter(x["impact"] for x in v)
    tags = {t for x in v for t in x["tags"]}
    rec.update(a11y_rules=len(v), a11y_nodes=sum(x["nodes"] for x in v), a11y_critical=by["critical"],
               a11y_serious=by["serious"], a11y_moderate=by["moderate"], a11y_minor=by["minor"],
               a11y_ids=" ".join(x["id"] for x in v),
               a11y_level=", ".join(lv for lv, ts in (("A", ("wcag2a", "wcag21a")), ("AA", ("wcag2aa", "wcag21aa", "wcag22aa")),
                                                      ("Boas práticas", ("best-practice",))) if tags & set(ts)))


# ---------- File > Settings > Trusted Certificates ----------
CERTS_FILE = Path(__file__).parent / "data" / "trusted_certs.pem"


def ssl_context():
    """System trust store plus the certificates the user added (e.g. a corporate proxy or staging CA)."""
    import ssl
    ctx = ssl.create_default_context()
    try:
        import certifi
        ctx.load_verify_locations(certifi.where())
    except Exception:
        pass
    if CERTS_FILE.exists() and CERTS_FILE.stat().st_size:
        try:
            ctx.load_verify_locations(str(CERTS_FILE))
        except Exception:
            pass
    return ctx



class _AnalysisStopped(Exception):
    """Crawl Analysis > Stop was requested."""
