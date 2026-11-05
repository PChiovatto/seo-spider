"""SEO Spider — local web app. Run: python -m uvicorn app:app --port 8765"""
import asyncio
import csv
import io
import json
import os
import re
import sys
import threading
import time
import uuid
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from xml.sax.saxutils import escape

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from openpyxl import Workbook
from pydantic import BaseModel, Field

from analysis import is_broken, is_html
from crawler import Crawler, CrawlConfig
from integrations import IntegrationError, Integrations, psi_fetch
import extraction
import storage

app = FastAPI(title="SEO Spider")
STATE = {"crawler": None, "task": None, "psi_task": None, "api_task": None}
INTEG = Integrations(Path(__file__).parent / "data")
extraction.register(app, STATE)

PAGE_COLUMNS = [k for k in Crawler._blank("", 0) if not k.startswith("_")]
EXTERNAL_COLUMNS = ["url", "status", "status_text", "content_type", "size", "response_ms", "inlinks"]
IMAGE_COLUMNS = ["url", "status", "status_text", "content_type", "size", "response_ms", "found_on", "missing_alt"]
LINK_COLUMNS = ["src", "dst", "anchor", "kind", "nofollow", "internal"]
_I18N_ALL = json.loads((Path(__file__).parent / "static" / "i18n.json").read_text(encoding="utf-8"))
_I18N = _I18N_ALL["strings"]
_TR = {lang: {row[0]: row[col] for row in _I18N} for lang, col in (("en", 1), ("es", 2))}
_VALUES = _I18N_ALL.get("values", {})   # raw crawl values such as "Non-Indexable"


_TPL = [(re.compile("^" + re.escape(r[0]).replace(re.escape("{{0}}"), "(.+?)").replace(re.escape("{{1}}"), "(.+?)") + "$"), r)
        for r in _I18N if "{{" in r[0]]


def tr(lang, s):
    """Translate a Portuguese UI/export string (exports follow the UI language)."""
    if not isinstance(s, str):
        return s
    hit = _VALUES.get(lang, {}).get(s) or _TR.get(lang, {}).get(s)
    if hit or lang not in ("en", "es"):
        return hit or s
    for rx, row in _TPL:  # templates such as "Title acima de {{0}} caracteres"
        m = rx.match(s)
        if m:
            out = row[1 if lang == "en" else 2]
            for i, g in enumerate(m.groups()):
                out = out.replace("{{%d}}" % i, g)
            return out
    return s


class Extractor(BaseModel):
    name: str = ""
    type: str = Field("css", pattern="^(css|xpath|regex)$")
    expr: str
    attr: str = ""


class JsSnippet(BaseModel):
    name: str = ""
    type: str = Field("extraction", pattern="^(extraction|action)$")
    content_type: str = "text/html"
    timeout: float = Field(10, ge=1, le=300)
    code: str = ""


class CrawlRequest(BaseModel):
    model_config = {"extra": "allow"}   # the many Crawl Config options are passed straight to CrawlConfig
    start_url: str = ""
    mode: str = Field("spider", pattern="^(spider|list)$")
    url_list: list[str] = []
    max_urls: int = Field(500, ge=1, le=100000)
    max_depth: int = Field(10, ge=0, le=100)
    concurrency: int = Field(5, ge=1, le=50)
    timeout: float = Field(20, ge=1, le=120)
    retries: int = Field(2, ge=0, le=5)
    max_rps: float = Field(0, ge=0, le=100)
    max_page_kb: int = Field(5120, ge=16, le=102400)
    respect_robots: bool = True
    respect_crawl_delay: bool = True
    crawl_sitemaps: bool = False
    check_external: bool = True
    check_images: bool = True
    crawl_subdomains: bool = False
    scope: str = Field("subdomain", pattern="^(subdomain|subfolder|all_subdomains)$")
    crawl_resources: bool = True
    include: list[str] = []
    exclude: list[str] = []
    strip_params: str = "utm_*, fbclid, gclid"
    strip_all_params: bool = False
    auth_user: str = ""
    auth_pass: str = ""
    render_js: bool = False
    near_dup_threshold: int = Field(90, ge=50, le=100)
    spelling: bool = False
    spell_lang: str = Field("auto", pattern="^(auto|pt|en|es|fr|de|it|nl|ru|ar|lv|eu|fa)$")
    spell_ignore: list[str] = []
    semantic: bool = True
    semantic_threshold: float = Field(0.9, ge=0.5, le=1.0)
    extractors: list[Extractor] = []
    custom_js: list[JsSnippet] = Field([], max_length=100)
    custom_search: list[dict] = Field([], max_length=100)
    custom_headers: list[str] = []
    proxy: str = ""
    robots_override: str = ""
    use_form_auth: bool = False
    accessibility: bool = False
    max_folder_depth: int = Field(-1, ge=-1, le=100)
    max_query_strings: int = Field(-1, ge=-1, le=100)
    max_url_length: int = Field(2000, ge=50, le=10000)
    max_links_per_url: int = Field(10000, ge=1, le=100000)
    max_redirects: int = Field(5, ge=0, le=20)
    path_limits: list[str] = []
    url_rewrite: list[str] = []
    lowercase_urls: bool = False
    cdn_domains: list[str] = []
    follow_internal_nofollow: bool = False
    analysis: list[str] | None = None
    auto_analyse: bool = True
    user_agent: str = "SEOSpiderClone/1.0"


class PsiRequest(BaseModel):
    url: str = ""
    all: bool = False
    limit: int = Field(50, ge=1, le=1000)
    strategy: str = Field("mobile", pattern="^(mobile|desktop)$")
    key: str = ""


def current() -> Crawler:
    c = STATE["crawler"]
    if not c:
        raise HTTPException(404, "Nenhum crawl iniciado")
    return c


def _with_scheme(u):
    u = u.strip()
    return u if not u or u.lower().startswith(("http://", "https://")) else "https://" + u


def make_crawler(req: CrawlRequest) -> Crawler:
    """Build a crawler from a request (used by the UI, the scheduler and the CLI)."""
    data = req.model_dump()
    if data["analysis"] is None:
        data.pop("analysis")
    data["start_url"] = _with_scheme(req.start_url)
    data["url_list"] = [_with_scheme(u) for u in req.url_list if u.strip()]
    data["auth_cookies"] = _form_cookies() if data.pop("use_form_auth") else []
    data["custom_search"] = [s for s in data["custom_search"] if isinstance(s, dict) and s.get("query")]
    known = CrawlConfig.__dataclass_fields__
    data = {k: v for k, v in data.items() if k in known}
    try:
        crawler = Crawler(CrawlConfig(**data))
    except re.error as e:
        raise HTTPException(400, f"Regex inválida: {e}")
    except ValueError as e:
        raise HTTPException(400, str(e))
    crawler.ai_bridge = INTEG.js_openai
    return crawler


@app.post("/api/crawl")
async def start_crawl(req: CrawlRequest):
    c = STATE["crawler"]
    if c and c.status == "running":
        raise HTTPException(409, "Já existe um crawl em andamento")
    crawler = make_crawler(req)
    STATE["crawler"] = crawler
    STATE["task"] = asyncio.create_task(_run_and_save(crawler, crawler.run()))
    return crawler.progress()


async def _run_and_save(c, coro):
    """Crawls are saved automatically when they finish (SF database storage mode)."""
    await coro
    await asyncio.to_thread(usage_crawl, c)   # Help > Usage Stats
    if c.cfg.grammar and c.status == "finished" and not c.grammar["running"]:  # Content > Spelling & Grammar
        pages = [p for p in c.pages.values() if is_html(p) and p.get("_text")][:200]
        c.grammar.update(running=True, done=0, total=len(pages), errors=0)
        await _grammar_bulk(c, pages)
    if not getattr(c.cfg, "autosave", True):  # memory storage mode: saved only on request
        return
    try:
        await asyncio.to_thread(storage.save, c)
    except Exception:
        pass


# ---------- File > Settings ----------
class Retention(BaseModel):
    days: int = Field(0, ge=0, le=36500)
    keep: int = Field(0, ge=0, le=100000)
    dry_run: bool = True


@app.post("/api/crawls/retention")
def crawls_retention(req: Retention):
    """Crawl Retention: saved crawls older than N days and/or beyond the N most recent (the open crawl is kept)."""
    cur = STATE["crawler"].crawl_id if STATE["crawler"] else None
    items = storage.list_crawls()   # newest first
    doomed = []
    for i, m in enumerate(items):
        if m["id"] == cur:
            continue
        old = req.days and m.get("saved", 0) < time.time() - req.days * 86400
        extra = req.keep and i >= req.keep
        if old or extra:
            doomed.append(m)
    if not req.dry_run:
        for m in doomed:
            storage.delete(m["id"])
    return {"crawls": [dict(id=m["id"], name=m["name"]) for m in doomed], "deleted": not req.dry_run}


def _memory():
    """Process and system memory (Windows API, with a generic fallback)."""
    out = {}
    try:
        import ctypes
        from ctypes import wintypes

        class MEMSTAT(ctypes.Structure):
            _fields_ = [("dwLength", wintypes.DWORD), ("dwMemoryLoad", wintypes.DWORD), ("ullTotalPhys", ctypes.c_ulonglong),
                        ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                        ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
        m = MEMSTAT()
        m.dwLength = ctypes.sizeof(MEMSTAT)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        out.update(total=m.ullTotalPhys, free=m.ullAvailPhys)
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        k32, psapi = ctypes.WinDLL("kernel32"), ctypes.WinDLL("psapi")
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
        psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
        out["process"] = pmc.WorkingSetSize
    except Exception:
        try:
            import resource
            out["process"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
        except Exception:
            pass
    return out


def _chromium_path():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except ImportError:
        return None
    import glob
    import os
    base = os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or str(Path.home() / "AppData" / "Local" / "ms-playwright")
    hits = sorted(glob.glob(str(Path(base) / "chromium-*")))
    return hits[-1] if hits else None


BROWSER_INSTALL = {"running": False, "log": "", "ok": None}


@app.get("/api/system")
def system_info():
    c = STATE["crawler"]
    crawls_dir = storage.DIR
    size = sum(f.stat().st_size for f in crawls_dir.glob("*") if f.is_file()) if crawls_dir.exists() else 0
    chromium = _chromium_path()
    return dict(memory=_memory(), crawl_urls=len(c.pages) if c else 0, storage_dir=str(crawls_dir), storage_size=size,
                saved_crawls=len(storage.list_crawls()), chromium=bool(chromium), chromium_path=chromium or "",
                browser_install=BROWSER_INSTALL, certs=CERTS_TEXT().count("BEGIN CERTIFICATE"),
                python=sys.version.split()[0], app_dir=str(Path(__file__).parent))


@app.post("/api/system/chromium")
async def install_chromium():
    """File > Settings > Embedded Browser: install / update the Chromium used for rendering (Playwright)."""
    if BROWSER_INSTALL["running"]:
        raise HTTPException(409, "A instalação já está em andamento")
    BROWSER_INSTALL.update(running=True, log="", ok=None)

    async def run():
        proc = await asyncio.create_subprocess_exec(sys.executable, "-m", "playwright", "install", "chromium",
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        out, _ = await proc.communicate()
        BROWSER_INSTALL.update(running=False, log=out.decode(errors="replace")[-3000:], ok=proc.returncode == 0)
    STATE["browser_install"] = asyncio.create_task(run())
    return BROWSER_INSTALL


def CERTS_TEXT():
    from crawler import CERTS_FILE
    try:
        return CERTS_FILE.read_text(encoding="utf-8")
    except OSError:
        return ""


class CertsReq(BaseModel):
    pem: str = Field("", max_length=2_000_000)


@app.get("/api/certs")
def certs_get():
    return {"pem": CERTS_TEXT()}


@app.post("/api/certs")
def certs_set(req: CertsReq):
    from crawler import CERTS_FILE, ssl_context
    pem = req.pem.strip()
    if pem and "BEGIN CERTIFICATE" not in pem:
        raise HTTPException(400, "O texto não contém nenhum certificado PEM (-----BEGIN CERTIFICATE-----)")
    CERTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CERTS_FILE.write_text(pem + ("\n" if pem else ""), encoding="utf-8")
    try:
        if pem:
            import ssl
            ssl.create_default_context().load_verify_locations(cadata=pem)
        ssl_context()
    except Exception as e:
        CERTS_FILE.write_text("", encoding="utf-8")
        raise HTTPException(400, f"Certificado inválido: {e}")
    return {"ok": True, "count": pem.count("BEGIN CERTIFICATE")}


@app.post("/api/shutdown")
async def shutdown():
    """File > Exit: stops the local server (the run.bat window closes)."""
    import os

    async def bye():
        await asyncio.sleep(0.5)
        os._exit(0)
    asyncio.create_task(bye())
    return {"ok": True}


# ---------- saved crawls (File > Crawls) ----------
class CrawlMeta(BaseModel):
    name: str | None = None
    project: str | None = None


def _idle():
    c = STATE["crawler"]
    if c and (c.status == "running" or c.psi["running"] or c.grammar["running"]
              or any(st["running"] for st in INTEG.state.values())):
        raise HTTPException(409, "Aguarde o fim do crawl")


@app.get("/api/crawls")
def crawls_list():
    c = STATE["crawler"]
    return {"crawls": storage.list_crawls(), "current": c.crawl_id if c else None}


@app.post("/api/crawls/save")
async def crawls_save(meta: CrawlMeta):
    c = current()
    _idle()
    if meta.name:
        c.crawl_name = meta.name
    if meta.project is not None:
        c.project = meta.project
    return await asyncio.to_thread(storage.save, c)


@app.post("/api/crawls/import")
async def crawls_import(request: Request):
    _idle()
    try:
        c = await asyncio.to_thread(storage.import_blob, await request.body())
    except Exception as e:
        raise HTTPException(400, f"Arquivo de crawl inválido: {e}"[:300])
    c.ai_bridge = INTEG.js_openai
    STATE["crawler"] = c
    return c.progress()


@app.post("/api/crawls/{crawl_id}/open")
async def crawls_open(crawl_id: str):
    _idle()
    try:
        c = await asyncio.to_thread(storage.load, crawl_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    c.ai_bridge = INTEG.js_openai
    STATE["crawler"] = c
    return c.progress()


@app.patch("/api/crawls/{crawl_id}")
def crawls_update(crawl_id: str, meta: CrawlMeta):
    c = STATE["crawler"]
    if c and c.crawl_id == crawl_id:
        c.crawl_name = meta.name if meta.name is not None else c.crawl_name
        c.project = meta.project if meta.project is not None else c.project
    out = storage.update(crawl_id, meta.name, meta.project)
    if out is None:
        raise HTTPException(404, "Crawl não encontrado")
    return out


@app.delete("/api/crawls/{crawl_id}")
def crawls_delete(crawl_id: str):
    storage.delete(crawl_id)
    return {"ok": True}


@app.get("/api/crawls/{crawl_id}/export")
def crawls_export(crawl_id: str):
    try:
        blob = storage.export_blob(crawl_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    name = next((m["name"] for m in storage.list_crawls() if m["id"] == crawl_id), crawl_id)
    safe = re.sub(r"[^\w.-]+", "-", name).strip("-")[:80] or crawl_id
    return Response(blob, media_type="application/gzip",
                    headers={"Content-Disposition": f'attachment; filename="{safe}.seospider.json.gz"'})


@app.get("/api/crawls/{crawl_id}/data")
async def crawls_data(crawl_id: str):
    """Snapshot of a saved crawl without opening it (used to compare every tab with a previous crawl)."""
    c = STATE["crawler"]
    if c and c.crawl_id == crawl_id:
        return c.snapshot()
    try:
        prev = await asyncio.to_thread(storage.load, crawl_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    return await asyncio.to_thread(prev.snapshot)


@app.get("/api/export-current")
def export_current():
    """File > Export: the open crawl as a crawl file (also works in memory storage mode)."""
    c = current()
    safe = re.sub(r"[^\w.-]+", "-", c.crawl_name).strip("-")[:80] or c.crawl_id
    return Response(storage.serialise(c), media_type="application/gzip",
                    headers={"Content-Disposition": f'attachment; filename="{safe}.seospider.json.gz"'})


# ---------- crawl comparison (Mode > Compare) ----------
@app.get("/api/compare")
async def compare(previous: str, current_id: str):
    _idle()
    c = STATE["crawler"]

    def get(cid):
        return c if c and c.crawl_id == cid else storage.load(cid)
    try:
        prev, curr = await asyncio.to_thread(get, previous), await asyncio.to_thread(get, current_id)
        return await asyncio.to_thread(storage.compare, prev, curr)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.post("/api/stop")
def stop_crawl():
    c = current()
    c.stop()
    return c.progress()


@app.post("/api/clear")
def clear_crawl():
    c = STATE["crawler"]
    if c and (c.status == "running" or c.psi["running"] or c.grammar["running"]):
        raise HTTPException(409, "Pare o crawl antes de limpar")
    STATE["crawler"] = STATE["task"] = None
    return {"ok": True}


@app.get("/api/status")
def status():
    c = STATE["crawler"]
    out = c.progress() if c else {"status": "empty"}
    out["integrations"] = INTEG.states()
    return out


@app.get("/api/data")
def data():
    return current().snapshot()


@app.get("/api/url")
def url_detail(url: str):
    d = current().url_detail(url)
    if d is None:
        raise HTTPException(404, "URL não encontrada")
    return d


@app.get("/api/source", response_class=PlainTextResponse)
def source(url: str, rendered: bool = False):
    s = current().source(url, rendered)
    if s is None:
        raise HTTPException(404, "Código-fonte não disponível")
    return s


# ---------- PageSpeed Insights ----------
async def _psi_bulk(c, urls, strategy, key):
    sem = asyncio.Semaphore(4)
    async with httpx.AsyncClient() as client:
        async def one(u):
            async with sem:
                if c.psi["running"]:
                    res = await psi_fetch(client, u, strategy, key)
                    c.pages[u].update(res)
                    c.psi["done"] += 1
                    c.psi["errors"] += bool(res.get("psi_error"))
        try:
            await asyncio.gather(*(one(u) for u in urls))
        finally:
            c.psi["running"] = False


@app.post("/api/psi")
async def pagespeed(req: PsiRequest):
    c = current()
    if req.url:
        rec = c.pages.get(req.url)
        if not rec:
            raise HTTPException(404, "URL não encontrada")
        async with httpx.AsyncClient() as client:
            rec.update(await psi_fetch(client, req.url, req.strategy, req.key or INTEG.conf('psi')['key']))
        return {k: v for k, v in rec.items() if k.startswith("psi_")}
    if c.psi["running"]:
        raise HTTPException(409, "PageSpeed já está rodando")
    urls = [p["url"] for p in c.pages.values() if is_html(p) and p["indexability"] == "Indexable"][:req.limit]
    c.psi.update(running=True, done=0, total=len(urls), errors=0)
    STATE["psi_task"] = asyncio.create_task(_psi_bulk(c, urls, req.strategy, req.key or INTEG.conf('psi')['key']))
    return c.psi


@app.post("/api/psi/stop")
def pagespeed_stop():
    c = current()
    c.psi["running"] = False
    return c.psi


# ---------- API integrations (API tab) ----------
class IntegrationValues(BaseModel):
    values: dict = {}


class IntegrationRun(BaseModel):
    ids: list[str] = []
    segments: list[dict] = []


def _provider(pid):
    if pid not in {p["id"] for p in INTEG.public()}:
        raise HTTPException(404, "Integração desconhecida")


class JsTest(BaseModel):
    url: str
    snippet: JsSnippet
    user_agent: str = "SEOSpiderClone/1.0"


@app.post("/api/customjs/test")
async def customjs_test(req: JsTest):
    from crawler import test_snippet
    url = _with_scheme(req.url)
    try:
        return await test_snippet(url, req.snippet.model_dump(), req.user_agent, INTEG.js_openai)
    except Exception as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}"[:300])


@app.get("/api/integrations")
def integrations_list():
    return INTEG.public()


@app.post("/api/integrations/run")
async def integrations_run(req: IntegrationRun):
    c = current()
    if c.status == "running":
        raise HTTPException(409, "Aguarde o fim do crawl")
    if any(st["running"] for st in INTEG.state.values()):
        raise HTTPException(409, "Já existe uma solicitação de API em andamento")
    if not any(INTEG.connected(p["id"]) for p in INTEG.public()):
        raise HTTPException(400, "Nenhuma API conectada")
    STATE["api_task"] = asyncio.create_task(INTEG.run(c, req.ids or None, req.segments))
    return INTEG.states()


@app.post("/api/integrations/stop")
def integrations_stop():
    INTEG.stop()
    return INTEG.states()


@app.post("/api/integrations/{pid}")
async def integrations_connect(pid: str, req: IntegrationValues):
    _provider(pid)
    INTEG.update(pid, req.values)
    try:
        await INTEG.connect(pid)
    except IntegrationError as e:
        raise HTTPException(400, str(e))
    return next(p for p in INTEG.public() if p["id"] == pid)


@app.post("/api/integrations/{pid}/disconnect")
def integrations_disconnect(pid: str):
    _provider(pid)
    INTEG.disconnect(pid)
    return next(p for p in INTEG.public() if p["id"] == pid)


@app.post("/api/integrations/{pid}/oauth")
async def integrations_oauth(pid: str, req: IntegrationValues):
    _provider(pid)
    INTEG.update(pid, req.values)
    try:
        await asyncio.to_thread(INTEG.oauth_login_sync, pid)
    except IntegrationError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, f"Falha no login Google: {e}")
    return next(p for p in INTEG.public() if p["id"] == pid)


@app.post("/api/integrations/{pid}/options")
async def integrations_options(pid: str, req: IntegrationValues):
    _provider(pid)
    INTEG.update(pid, req.values)
    try:
        return await INTEG.options(pid)
    except IntegrationError as e:
        raise HTTPException(400, str(e))



# ---------- grammar (LanguageTool public API, opt-in) ----------
LT_URL = "https://api.languagetool.org/v2/check"
LT_LANGS = {"pt": "pt-BR", "en": "en-US", "de": "de-DE", "es": "es", "fr": "fr", "it": "it", "nl": "nl", "ru": "ru-RU", "fa": "fa", "ar": "ar"}


class GrammarRequest(BaseModel):
    limit: int = Field(50, ge=1, le=1000)


async def _grammar_bulk(c, pages):
    async with httpx.AsyncClient(timeout=60) as client:
        try:
            for p in pages:
                if not c.grammar["running"]:
                    break
                lang = LT_LANGS.get(c.lang_of(p), "auto")
                try:
                    form = {"text": c.text_of(p)[:18000], "language": lang}
                    if c.cfg.grammar_disabled:
                        form["disabledRules"] = ",".join(x.strip() for x in c.cfg.grammar_disabled if x.strip())
                    r = await client.post(LT_URL, data=form)
                    r.raise_for_status()
                    matches = [m for m in r.json().get("matches", [])
                               if m.get("rule", {}).get("category", {}).get("id") != "TYPOS"]
                    p["_grammar"] = [dict(message=m.get("message", ""),
                                          context=m.get("context", {}).get("text", ""),
                                          offset=m.get("context", {}).get("offset", 0),
                                          length=m.get("context", {}).get("length", 0),
                                          suggestions=[x["value"] for x in m.get("replacements", [])[:3]])
                                     for m in matches[:200]]
                    p["grammar_errors"] = len(matches)
                except (httpx.HTTPError, ValueError):
                    c.grammar["errors"] += 1
                c.grammar["done"] += 1
                await asyncio.sleep(3.2)  # public API limit: 20 requests/minute
        finally:
            c.grammar["running"] = False


@app.post("/api/grammar")
async def grammar(req: GrammarRequest):
    c = current()
    if c.grammar["running"]:
        raise HTTPException(409, "A verificação de gramática já está rodando")
    pages = [p for p in c.pages.values() if is_html(p) and p.get("_text")][:req.limit]
    c.grammar.update(running=True, done=0, total=len(pages), errors=0)
    STATE["grammar_task"] = asyncio.create_task(_grammar_bulk(c, pages))
    return c.grammar


@app.post("/api/grammar/stop")
def grammar_stop():
    c = current()
    c.grammar["running"] = False
    return c.grammar


@app.get("/api/semantic")
async def semantic(q: str):
    c = current()
    if not c.semantic:
        raise HTTPException(409, "Índice semântico indisponível — rode a Análise de crawl (mínimo de 3 páginas indexáveis)")
    if c.semantic.get("embedder"):
        try:
            return c.semantic_search(q, vector=await INTEG.embed_query(c.semantic["embedder"], q))
        except IntegrationError as e:
            raise HTTPException(400, str(e))
    return c.semantic_search(q)


@app.get("/api/semantic/map")
def semantic_map_view():
    from analysis import semantic_map
    c = current()
    if not c.semantic or len(c.semantic["urls"]) < 3:
        raise HTTPException(409, "Índice semântico indisponível — rode a Análise de crawl (mínimo de 3 páginas indexáveis)")
    points, names = semantic_map(c.semantic["index"])
    for pt, u in zip(points, c.semantic["urls"]):
        p = c.pages.get(u, {})
        pt.update(url=u, title=p.get("title", ""), low=bool(p.get("low_relevance")))
    return {"points": points, "clusters": names, "source": "embeddings" if c.semantic.get("embedder") else "tfidf"}


@app.get("/api/graph")
def link_graph(limit: int = 500):
    """Nodes/edges for the force-directed crawl diagram (HTML pages + internal follow links)."""
    c = current()
    pages = [p for p in c.pages.values() if is_html(p) or p["status"] not in (None, 200)]
    pages.sort(key=lambda p: (p["depth"] if p["depth"] is not None else 99, -(p["link_score"] or 0)))
    keep = {p["url"] for p in pages[:limit]}
    edges, seen = [], set()
    for l in c.links:
        if l["kind"] == "a" and not l["nofollow"] and l["src"] in keep and l["dst"] in keep and l["src"] != l["dst"]:
            k = (l["src"], l["dst"])
            if k not in seen:
                seen.add(k)
                edges.append(k)
                if len(edges) >= 4000:
                    break
    nodes = [dict(url=p["url"], depth=p["depth"], status=p["status"], indexability=p["indexability"],
                  link_score=p["link_score"], inlinks=p["unique_inlinks"]) for p in pages[:limit]]
    return {"nodes": nodes, "edges": edges, "total": len(pages)}


class NgramReq(BaseModel):
    urls: list[str]
    n: int = Field(2, ge=1, le=6)
    stopwords: bool = True


@app.post("/api/ngrams")
def ngrams(req: NgramReq):
    return current().ngrams(req.urls, req.n, req.stopwords)


@app.get("/api/ngrams/pages")
def ngram_pages(phrase: str):
    return current().ngram_pages(phrase)


@app.get("/api/why")
def why_not(url: str):
    return current().why_not(_with_scheme(url))


# ---------- robots.txt tester ----------
class RobotsTest(BaseModel):
    robots_text: str
    urls: list[str]
    user_agent: str = "SEOSpiderClone/1.0"


@app.get("/api/robots")
async def robots_get(url: str, user_agent: str = "SEOSpiderClone/1.0"):
    from urllib.parse import urlparse
    p = urlparse(_with_scheme(url))
    c = STATE["crawler"]
    if c and p.netloc in c.robots_text:
        return {"robots_url": f"{p.scheme}://{p.netloc}/robots.txt", "text": c.robots_text[p.netloc], "source": "crawl"}
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers={"User-Agent": user_agent}) as client:
            r = await client.get(f"{p.scheme}://{p.netloc}/robots.txt")
        return {"robots_url": str(r.url), "text": r.text if r.status_code == 200 else "", "status": r.status_code, "source": "live"}
    except httpx.HTTPError as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}")


@app.post("/api/robots/test")
def robots_test(req: RobotsTest):
    from robots import Robots
    rb = Robots(req.robots_text)
    out = []
    for u in req.urls[:2000]:
        u = _with_scheme(u.strip())
        if u:
            allowed, line, lineno = rb.check(u, req.user_agent)
            out.append(dict(url=u, allowed=allowed, line=line or "", lineno=lineno))
    return out


# ---------- forms-based authentication (log in once in a real browser window) ----------
FORM_AUTH_PATH = Path(__file__).parent / "data" / "form_auth.json"


def _form_cookies():
    try:
        return json.loads(FORM_AUTH_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


class FormAuthStart(BaseModel):
    url: str


# ---------- Authentication > Profiles (local file data/auth_default.json, never served statically) ----------
AUTH_DEFAULT = Path(__file__).parent / "data" / "auth_default.json"


@app.get("/api/auth/default")
def auth_default_get():
    try:
        return json.loads(AUTH_DEFAULT.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


@app.post("/api/auth/default")
async def auth_default_set(request: Request):
    data = await request.json()
    AUTH_DEFAULT.parent.mkdir(parents=True, exist_ok=True)
    AUTH_DEFAULT.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return {"ok": True}


@app.delete("/api/auth/default")
def auth_default_clear():
    AUTH_DEFAULT.unlink(missing_ok=True)
    return {"ok": True}


@app.get("/api/formauth/export")
def formauth_export():
    return {"cookies": _form_cookies()}


@app.post("/api/formauth/import")
async def formauth_import(request: Request):
    data = await request.json()
    cookies = [c for c in data.get("cookies", []) if isinstance(c, dict) and c.get("name")]
    FORM_AUTH_PATH.parent.mkdir(parents=True, exist_ok=True)
    FORM_AUTH_PATH.write_text(json.dumps(cookies), encoding="utf-8")
    return {"ok": True, "cookies": len(cookies)}


@app.get("/api/formauth")
def formauth_status():
    cookies = _form_cookies()
    return {"active": STATE.get("form_browser") is not None, "cookies": len(cookies),
            "domains": sorted({c.get("domain", "").lstrip(".") for c in cookies})}


@app.post("/api/formauth/start")
async def formauth_start(req: FormAuthStart):
    from playwright.async_api import async_playwright
    await _formauth_close()
    pw = await async_playwright().start()
    browser = await pw.chromium.launch(headless=False)
    ctx = await browser.new_context()
    page = await ctx.new_page()
    await page.goto(_with_scheme(req.url))
    STATE["form_browser"] = (pw, browser, ctx)
    return formauth_status()


async def _formauth_close():
    fb = STATE.pop("form_browser", None)
    if fb:
        pw, browser, _ = fb
        try:
            await browser.close()
            await pw.stop()
        except Exception:
            pass


@app.post("/api/formauth/finish")
async def formauth_finish():
    fb = STATE.get("form_browser")
    if not fb:
        raise HTTPException(409, "Nenhuma janela de login aberta")
    cookies = await fb[2].cookies()
    FORM_AUTH_PATH.parent.mkdir(exist_ok=True)
    FORM_AUTH_PATH.write_text(json.dumps(cookies), encoding="utf-8")
    await _formauth_close()
    return formauth_status()


@app.delete("/api/formauth")
async def formauth_clear():
    await _formauth_close()
    FORM_AUTH_PATH.unlink(missing_ok=True)
    return formauth_status()


# ---------- GA4 / Search Console URLs that the crawl didn't find (orphans) ----------
@app.post("/api/crawl-more")
async def crawl_more():
    c = current()
    if c.status == "running":
        raise HTTPException(409, "Já existe um crawl em andamento")
    urls = [u for u in c.api_urls if u not in c.pages]
    if not urls:
        raise HTTPException(400, "Nenhuma URL nova do GA4/Search Console para rastrear")
    sources = {u: sorted(c.api_urls[u])[0] for u in urls}
    STATE["task"] = asyncio.create_task(_run_and_save(c, c.crawl_more(urls, sources)))
    return {"urls": len(urls)}


# ---------- AI prompt tester ----------
class PromptTest(BaseModel):
    url: str
    prompt: dict


class _Adhoc:
    """Minimal crawler stand-in for testing a prompt on a URL that isn't in the crawl."""
    def __init__(self, html, text):
        self._html, self._text = html, text

    def text_of(self, _p):
        return self._text

    def source(self, _url, rendered=False):
        return self._html


@app.post("/api/integrations/{pid}/prompt-test")
async def prompt_test(pid: str, req: PromptTest):
    _provider(pid)
    url = _with_scheme(req.url)
    c = STATE["crawler"]
    if c and url in c.pages and is_html(c.pages[url]):
        page, src = c.pages[url], c
    else:
        from bs4 import BeautifulSoup
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
                r = await client.get(url)
        except httpx.HTTPError as e:
            raise HTTPException(400, f"{type(e).__name__}: {e}")
        soup = BeautifulSoup(r.text, "lxml")
        md = soup.find("meta", attrs={"name": "description"})
        h1 = soup.find("h1")
        page = dict(url=url, title=soup.title.get_text(strip=True) if soup.title else "",
                    meta_desc=(md.get("content") or "") if md else "", h1_1=h1.get_text(" ", strip=True) if h1 else "")
        for t in soup(["script", "style", "noscript", "nav", "header", "footer", "aside"]):
            t.decompose()
        src = _Adhoc(r.text, " ".join((soup.body or soup).get_text(" ").split()))
    try:
        return await INTEG.test_prompt(pid, req.prompt, page, src)
    except IntegrationError as e:
        raise HTTPException(400, str(e))
    except httpx.HTTPError as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}")


class AnalysisReq(BaseModel):
    groups: list[str] | None = None


class ConfigTest(BaseModel):
    config: dict = {}
    url: str = ""
    start_url: str = ""
    kind: str = Field("rewrite", pattern="^(rewrite|include|exclude|cdn)$")


@app.post("/api/config/test")
def config_test(req: ConfigTest):
    """Testers of Crawl Config > URL Rewriting / Include / Exclude / CDNs."""
    known = CrawlConfig.__dataclass_fields__
    cfg = {k: v for k, v in req.config.items() if k in known and k not in ("url_list", "mode")}
    url = _with_scheme(req.url)
    cfg.update(start_url=_with_scheme(req.start_url) or url or "https://www.example.com/", mode="spider")
    try:
        c = Crawler(CrawlConfig(**cfg))
    except (re.error, ValueError) as e:
        return dict(ok=False, error=str(e))
    normalized = c.norm(url) if url else ""
    out = dict(ok=True, normalized=normalized or "")
    if req.kind == "include":
        hits = [r.pattern for r in c._include if r.search(normalized or url)]
        out.update(configured=bool(c._include), matched=hits)
    elif req.kind == "exclude":
        hits = [r.pattern for r in c._exclude if r.search(normalized or url)]
        out.update(configured=bool(c._exclude), matched=hits)
    elif req.kind == "cdn":
        out.update(internal=bool(normalized) and c.is_internal(normalized))
    return out


class PrefsReq(BaseModel):
    prefs: dict = {}
    weak_anchors: list[str] | None = None
    soft404_phrases: list[str] | None = None


@app.post("/api/prefs")
def update_prefs(req: PrefsReq):
    """Spider > Preferences apply to the open crawl at once (filters and issues are recalculated)."""
    c = STATE["crawler"]
    if c:
        c.cfg.prefs = req.prefs
        if req.weak_anchors is not None:
            c.cfg.weak_anchors = req.weak_anchors
    return {"ok": True}


@app.post("/api/analyze")
async def crawl_analysis(req: AnalysisReq | None = None):
    """Crawl Analysis > Start: runs in the background, the UI stays usable (progress in /api/status)."""
    c = current()
    if c.status == "running":
        raise HTTPException(409, "Aguarde o fim do crawl")
    if c.analysis["running"]:
        raise HTTPException(409, "A análise de crawl já está em andamento")
    groups = req.groups if req and req.groups is not None else None
    if groups is not None:
        c.cfg.analysis = groups
    c.analysis.update(running=True, done=0, total=1)
    STATE["analysis_task"] = asyncio.create_task(asyncio.to_thread(c.finalize, groups))
    return {"ok": True}


@app.post("/api/analyze/stop")
def crawl_analysis_stop():
    """Crawl Analysis > Stop."""
    c = current()
    if not c.analysis.get("running"):
        return {"ok": True, "running": False}
    c.analysis["stop"] = True
    return {"ok": True, "running": True}


# ---------- Help > Usage Stats ----------
USAGE_FILE = Path(__file__).parent / "data" / "usage.json"
_USAGE_LOCK = threading.Lock()


def _usage_load():
    try:
        return json.loads(USAGE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"months": {}}


def usage_add(fn):
    """Update this month's usage record (best effort, never breaks the caller)."""
    try:
        with _USAGE_LOCK:
            data = _usage_load()
            m = data.setdefault("months", {}).setdefault(time.strftime("%Y-%m"), {})
            fn(m)
            USAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
            USAGE_FILE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def _usage_count(m, bucket, name, n=1):
    b = m.setdefault(bucket, {})
    b[name] = b.get(name, 0) + n


def usage_crawl(c):
    pages = list(c.pages.values())
    issues = []
    try:
        issues = c.analyze()
    except Exception:
        pass
    secs = max(0, (getattr(c, "finished", 0) or time.time()) - (getattr(c, "started", 0) or time.time()))

    def upd(m):
        m["crawls"] = m.get("crawls", 0) + 1
        m["urls"] = m.get("urls", 0) + len(pages)
        m["seconds"] = m.get("seconds", 0) + secs
        m["largest"] = max(m.get("largest", 0), len(pages))
        m["robots_noindex"] = m.get("robots_noindex", 0) + sum(1 for p in pages if p.get("robots_blocked") and "noindex" in (p.get("meta_robots") or "").lower())
        m["largest_image"] = max(m.get("largest_image", 0), max([p.get("size") or 0 for p in pages if (p.get("content_type") or "").startswith("image/")] or [0]))
        for i in issues:
            n = len(i.get("urls") or [])
            if n:
                _usage_count(m, "issues", i["name"], n)
                key = {"Issue": "errors", "Warning": "warnings", "Opportunity": "opportunities"}.get(i.get("type"))
                if key:
                    m[key] = m.get(key, 0) + n
    usage_add(upd)


@app.post("/api/usage/{bucket}")
def usage_hit(bucket: str, name: str = ""):
    if bucket not in ("tabs", "exports") or not name or len(name) > 120:
        raise HTTPException(400, "inválido")
    usage_add(lambda m: _usage_count(m, bucket, name))
    return {"ok": True}


@app.get("/api/usage")
def usage_get(period: str = "month"):
    months = _usage_load().get("months", {})
    now = time.localtime()
    if period == "month":
        keys = [time.strftime("%Y-%m")]
    elif period == "year":
        keys = [k for k in months if k.startswith(str(now.tm_year))]
    elif period == "lastyear":
        keys = [k for k in months if k.startswith(str(now.tm_year - 1))]
    else:
        keys = list(months)
    tot = {"crawls": 0, "urls": 0, "seconds": 0, "largest": 0, "errors": 0, "warnings": 0, "opportunities": 0,
           "robots_noindex": 0, "largest_image": 0, "issues": {}, "exports": {}, "tabs": {}}
    for k in keys:
        m = months.get(k, {})
        for f in ("crawls", "urls", "seconds", "errors", "warnings", "opportunities", "robots_noindex"):
            tot[f] += m.get(f, 0)
        for f in ("largest", "largest_image"):
            tot[f] = max(tot[f], m.get(f, 0))
        for b in ("issues", "exports", "tabs"):
            for n, v in (m.get(b) or {}).items():
                tot[b][n] = tot[b].get(n, 0) + v
    for b in ("issues", "exports", "tabs"):
        tot[b] = sorted(tot[b].items(), key=lambda x: -x[1])[:10]
    tot["per_month"] = [(k, months[k].get("crawls", 0), months[k].get("urls", 0)) for k in sorted(months)]
    return tot


# ---------- MCP server (Model Context Protocol, JSON-RPC over HTTP) ----------
MCP_FILE = Path(__file__).parent / "data" / "mcp.json"
MCP_STATE = {"running": False}


MCP_DEFAULTS = {"autostart": False, "port": 11435, "max_bytes": 100000, "directory": str(Path.home() / "seo_spider_mcp_server")}


def _mcp_cfg():
    try:
        cfg = json.loads(MCP_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cfg = {}
    return {**MCP_DEFAULTS, **cfg}


def _mcp_dir_check(d):
    """The directory must exist (or be creatable) and be writable."""
    try:
        path = Path(d).expanduser()
        if not path.is_absolute():
            return "Use um caminho completo (ex.: C:\\Users\\voce\\seo_spider_mcp_server)"
        target = path
        while not target.exists():          # not created yet: check the nearest existing parent (created on first use)
            if target.parent == target:
                return "Pasta inválida"
            target = target.parent
        if not target.is_dir():
            return "O caminho aponta para um arquivo, não para uma pasta"
        if not os.access(target, os.W_OK):
            return "Sem permissão de escrita nesta pasta"
        return ""
    except OSError as e:
        return f"Pasta inválida: {e.strerror or e}"


def _mcp_tools():
    s = lambda **p: {"type": "object", "properties": p, "additionalProperties": False}
    return [
        dict(name="crawl_start", description="Start a crawl of a website (spider mode).",
             inputSchema=dict(s(url={"type": "string", "description": "Start URL"}, max_urls={"type": "integer", "minimum": 1, "maximum": 100000}), required=["url"])),
        dict(name="crawl_stop", description="Stop the running crawl.", inputSchema=s()),
        dict(name="crawl_status", description="Progress of the current crawl (status, URLs crawled, queued, errors).", inputSchema=s()),
        dict(name="crawl_summary", description="Overview of the current crawl: totals, indexability and response codes.", inputSchema=s()),
        dict(name="list_issues", description="Issues found in the current crawl, with type, priority and number of URLs.",
             inputSchema=s(type={"type": "string", "enum": ["Issue", "Warning", "Opportunity"]})),
        dict(name="issue_urls", description="URLs affected by one issue (name as returned by list_issues).",
             inputSchema=dict(s(name={"type": "string"}, limit={"type": "integer", "minimum": 1, "maximum": 5000}), required=["name"])),
        dict(name="get_url", description="All crawl data for one URL (title, meta, headings, status, indexability, links…).",
             inputSchema=dict(s(url={"type": "string"}), required=["url"])),
        dict(name="list_saved_crawls", description="Saved crawls (id, name, date, URLs).", inputSchema=s()),
        dict(name="open_saved_crawl", description="Open a saved crawl by id so the other tools work on it.",
             inputSchema=dict(s(id={"type": "string"}), required=["id"])),
        dict(name="export_to_file", description="Write a bulk export (CSV) or report to the MCP directory and return the file path.",
             inputSchema=dict(s(kind={"type": "string", "description": "bulk kind (e.g. all-links) or report:<kind> (e.g. report:redirect-chains)"},
                                filename={"type": "string"}), required=["kind"])),
        dict(name="bulk_export", description="Bulk export as CSV text (e.g. all-links, broken, external, issues, images-all).",
             inputSchema=dict(s(kind={"type": "string"}, max_chars={"type": "integer", "minimum": 1000, "maximum": 2000000}), required=["kind"])),
    ]


async def _mcp_call(name, args):
    if name == "crawl_start":
        await start_crawl(CrawlRequest(start_url=args["url"], **({"max_urls": args["max_urls"]} if args.get("max_urls") else {})))
        return STATE["crawler"].progress()
    if name == "crawl_stop":
        return stop_crawl()
    if name == "crawl_status":
        return STATE["crawler"].progress() if STATE["crawler"] else {"status": "empty"}
    if name == "list_saved_crawls":
        return [dict(id=m["id"], name=m["name"], urls=m.get("urls"), saved=time.strftime("%Y-%m-%d %H:%M", time.localtime(m.get("saved", 0))))
                for m in storage.list_crawls()]
    if name == "open_saved_crawl":
        return await crawls_open(args["id"])
    c = current()
    if name == "crawl_summary":
        pages = list(c.pages.values())
        codes = {}
        for p in pages:
            k = f'{(p.get("status") or 0) // 100}xx' if p.get("status") else "sem resposta"
            codes[k] = codes.get(k, 0) + 1
        return dict(start_url=c.start_url, status=c.status, internal=len(pages), external=len(c.external), images=len(c.images),
                    indexable=sum(1 for p in pages if p.get("indexability") == "Indexable"), response_codes=codes)
    if name == "list_issues":
        out = [dict(name=i["name"], type=i["type"], priority=i["priority"], urls=len(i["urls"])) for i in c.analyze() if i["urls"]]
        return [i for i in out if not args.get("type") or i["type"] == args["type"]]
    if name == "issue_urls":
        hit = next((i for i in c.analyze() if i["name"] == args["name"]), None)
        if not hit:
            raise ValueError("issue not found: " + args["name"])
        return hit["urls"][: args.get("limit") or 500]
    if name == "get_url":
        d = c.url_detail(args["url"])
        if d is None:
            raise ValueError("URL not in this crawl")
        return dict(record=d["record"], inlinks=len(d["links"]["inlinks"]), outlinks=len(d["links"]["outlinks"]))
    if name == "bulk_export":
        body = _bulk(c, args["kind"], "en").body.decode("utf-8-sig", errors="replace")
        return body[: args.get("max_chars") or 200000]
    if name == "export_to_file":
        cfg = _mcp_cfg()
        err = _mcp_dir_check(cfg["directory"])
        if err:
            raise ValueError(err)
        kind = args["kind"]
        body = (_report(c, kind[7:], "en") if kind.startswith("report:") else _bulk(c, kind, "en")).body
        fname = re.sub(r"[^\w.-]+", "-", args.get("filename") or kind.replace("report:", "report-")).strip("-") or "export"
        if not fname.lower().endswith(".csv"):
            fname += ".csv"
        Path(cfg["directory"]).expanduser().mkdir(parents=True, exist_ok=True)
        out = Path(cfg["directory"]).expanduser() / fname
        out.write_bytes(body)
        return {"path": str(out), "bytes": len(body)}
    raise ValueError("unknown tool: " + name)


async def mcp_endpoint(request: Request):
    """MCP server (Streamable HTTP, JSON responses) served on its own local port (Settings > MCP Server)."""
    origin = request.headers.get("origin", "")
    if origin and not re.match(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$", origin):
        raise HTTPException(403, "origin not allowed")   # DNS-rebinding protection
    try:
        msg = await request.json()
    except ValueError:
        return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
    max_bytes = int(_mcp_cfg().get("max_bytes") or 100000)

    async def one(m):
        mid, method, params = m.get("id"), m.get("method"), m.get("params") or {}
        if mid is None:          # notification (e.g. notifications/initialized)
            return None
        try:
            if method == "initialize":
                res = {"protocolVersion": params.get("protocolVersion") or "2025-03-26",
                       "capabilities": {"tools": {"listChanged": False}},
                       "serverInfo": {"name": "seo-spider", "version": "1.0"}}
            elif method == "ping":
                res = {}
            elif method == "tools/list":
                res = {"tools": _mcp_tools()}
            elif method == "tools/call":
                try:
                    out = await _mcp_call(params.get("name"), params.get("arguments") or {})
                    text = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False, default=str)
                    size = len(text.encode("utf-8"))
                    if size > max_bytes:   # Max Response Size (Bytes)
                        res = {"content": [{"type": "text", "text": f"Response of {size} bytes exceeds the maximum of {max_bytes} bytes "
                                            "(Settings > MCP Server). Ask for less data (limit / max_chars) or use export_to_file."}], "isError": True}
                    else:
                        res = {"content": [{"type": "text", "text": text}], "isError": False}
                except (HTTPException, ValueError, KeyError) as e:
                    res = {"content": [{"type": "text", "text": str(getattr(e, "detail", e))}], "isError": True}
                MCP_STATE["calls"] = MCP_STATE.get("calls", 0) + 1
            else:
                return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "Method not found"}}
            return {"jsonrpc": "2.0", "id": mid, "result": res}
        except Exception as e:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": str(e)[:300]}}
    if isinstance(msg, list):
        out = [r for r in [await one(m) for m in msg] if r]
        return JSONResponse(out) if out else Response(status_code=202)
    r = await one(msg)
    return JSONResponse(r) if r else Response(status_code=202)


# the MCP server is a separate small app on its own port (default 11435), started/stopped from the UI
mcp_app = FastAPI(title="SEO Spider MCP")
mcp_app.add_api_route("/mcp", mcp_endpoint, methods=["POST"])
mcp_app.add_api_route("/mcp", lambda: PlainTextResponse("Use POST (JSON-RPC)", status_code=405), methods=["GET"])


async def mcp_start():
    import uvicorn
    if MCP_STATE.get("server"):
        return
    port = int(_mcp_cfg()["port"])
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:   # a busy port must never take the app down
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            MCP_STATE.update(server=None, task=None, running=False, error=f"Não foi possível usar a porta {port} (já está em uso?)")
            return
    server = uvicorn.Server(uvicorn.Config(mcp_app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    server.install_signal_handlers = lambda: None
    MCP_STATE.update(server=server, error="", port=port)

    async def serve():
        try:
            await server.serve()
        except BaseException:   # uvicorn calls sys.exit() when it cannot bind: keep it inside this task
            pass
    MCP_STATE["task"] = asyncio.create_task(serve())
    for _ in range(50):     # wait until it is listening (or failed, e.g. port in use)
        await asyncio.sleep(0.05)
        if server.started or MCP_STATE["task"].done():
            break
    if not server.started:
        MCP_STATE.update(server=None, task=None, error=f"Não foi possível usar a porta {port} (já está em uso?)")
    MCP_STATE["running"] = bool(server.started)


async def mcp_stop():
    server = MCP_STATE.get("server")
    if server:
        server.should_exit = True
        try:
            await asyncio.wait_for(MCP_STATE["task"], 5)
        except Exception:
            pass
    MCP_STATE.update(server=None, task=None, running=False)


class McpReq(BaseModel):
    running: bool | None = None
    autostart: bool | None = None
    port: int | None = Field(None, ge=1024, le=65535)
    max_bytes: int | None = Field(None, ge=1000, le=100_000_000)
    directory: str | None = Field(None, max_length=500)


@app.get("/api/mcp")
def mcp_status():
    cfg = _mcp_cfg()
    port = MCP_STATE.get("port") or cfg["port"]
    return dict(running=MCP_STATE["running"], autostart=cfg["autostart"], port=cfg["port"], max_bytes=cfg["max_bytes"],
                directory=cfg["directory"], directory_error=_mcp_dir_check(cfg["directory"]), defaults=MCP_DEFAULTS,
                url=f"http://127.0.0.1:{port}/mcp", error=MCP_STATE.get("error", ""), calls=MCP_STATE.get("calls", 0),
                tools=[dict(name=t["name"], description=t["description"]) for t in _mcp_tools()])


@app.post("/api/mcp")
async def mcp_set(req: McpReq):
    cfg = _mcp_cfg()
    changed = False
    for k in ("autostart", "port", "max_bytes", "directory"):
        v = getattr(req, k)
        if v is not None and v != cfg.get(k):
            cfg[k] = v.strip() if isinstance(v, str) else v
            changed = True
    if changed:
        MCP_FILE.parent.mkdir(parents=True, exist_ok=True)
        MCP_FILE.write_text(json.dumps({k: cfg[k] for k in MCP_DEFAULTS}), encoding="utf-8")
    restart = req.port is not None and MCP_STATE["running"] and MCP_STATE.get("port") != cfg["port"]
    if req.running is False or restart:
        await mcp_stop()
    if req.running or restart:
        await mcp_start()
    return mcp_status()


@app.post("/api/mcp/check-dir")
def mcp_check_dir(req: McpReq):
    return {"error": _mcp_dir_check(req.directory or "")}


@app.get("/api/mcp/tools.md")
def mcp_tools_md():
    lines = ["# SEO Spider — MCP server tools", ""]
    for t_ in _mcp_tools():
        lines += [f"## {t_['name']}", "", t_["description"], ""]
        props = t_["inputSchema"].get("properties", {})
        if props:
            req_ = set(t_["inputSchema"].get("required", []))
            lines += ["| Parameter | Type | Required | Description |", "|---|---|---|---|"]
            lines += [f"| {k} | {v.get('type', '')} | {'yes' if k in req_ else 'no'} | {v.get('description', '')} |" for k, v in props.items()]
            lines.append("")
    return Response("\n".join(lines), media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="seo-spider-mcp-tools.md"'})


@app.on_event("startup")
async def _mcp_autostart():
    if _mcp_cfg().get("autostart"):
        try:
            await mcp_start()
        except Exception as e:
            MCP_STATE.update(running=False, error=str(e))


@app.on_event("shutdown")
async def _mcp_shutdown():
    await mcp_stop()


# ---------- bulk exports & reports ----------
def _csv(name, header, rows, lang="pt"):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([tr(lang, h) for h in header])
    w.writerows(rows)
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{tr(lang, name)}.csv"'})


@app.get("/api/bulk/{kind}.csv")
def bulk_export(kind: str, lang: str = "pt"):
    out = _bulk(current(), kind, lang)
    usage_add(lambda m: _usage_count(m, "exports", "bulk:" + kind))
    return out


def _bulk(c, kind, lang="pt"):
    c.analyze()
    st = c._status_of
    if kind == "all-links":
        return _csv("todos-os-links", ["Origem", "Destino", "Âncora", "Tipo", "Nofollow", "Interno", "Código destino"],
                    ([l["src"], l["dst"], l["anchor"], l["kind"], l["nofollow"], l["internal"], st(l["dst"])] for l in c.links), lang)
    if kind == "broken":
        broken = {r["url"] for r in list(c.pages.values()) + list(c.external.values()) if is_broken(r)}
        return _csv("links-quebrados", ["Origem", "Destino", "Âncora", "Tipo", "Código destino"],
                    ([l["src"], l["dst"], l["anchor"], l["kind"], st(l["dst"])] for l in c.links if l["dst"] in broken), lang)
    if kind == "external":
        return _csv("links-externos", ["Origem", "Destino", "Âncora", "Nofollow", "Código destino"],
                    ([l["src"], l["dst"], l["anchor"], l["nofollow"], st(l["dst"])] for l in c.links if not l["internal"]), lang)
    if kind == "images-missing-alt":
        return _csv("imagens-sem-alt", ["Página", "Imagem", "Alt"],
                    ([r["page"], r["src"], tr(lang, "(sem atributo)") if r["alt"] is None else r["alt"]]
                     for r in c.image_refs if r["alt"] is None or not r["alt"].strip()), lang)
    if kind == "uncrawlable":
        return _csv("outlinks-nao-rastreaveis", ["Origem", "Destino", "Texto", "Formato do link", "Posição do link", "Interno", "Código destino"],
                    ([l["src"], l["dst"], l["anchor"], l.get("via", ""), tr(lang, l.get("position", "")), l["internal"], st(l["dst"])]
                     for l in c.links if l["kind"] == "uncrawlable"), lang)
    if kind == "skipped":
        return _csv("urls-nao-rastreadas", ["URL", "Motivo", "Encontrada em"],
                    ([u, r, src] for u, (r, src) in c.skipped.items()), lang)
    if kind == "issues":
        return _csv("todos-os-problemas", ["Problema", "Tipo", "Prioridade", "URL"],
                    ([tr(lang, i["name"]), tr(lang, i["type"]), tr(lang, i["priority"]), u] for i in c.analyze() for u in i["urls"]), lang)
    if kind in ("inlinks-3xx", "inlinks-4xx", "inlinks-5xx", "inlinks-noresp"):
        lo = {"inlinks-3xx": 300, "inlinks-4xx": 400, "inlinks-5xx": 500}.get(kind)
        match = (lambda s: s == 0) if lo is None else (lambda s: s is not None and lo <= s < lo + 100)
        return _csv(kind, ["Origem", "Destino", "Âncora", "Tipo", "Código destino"],
                    ([l["src"], l["dst"], l["anchor"], l["kind"], st(l["dst"])] for l in c.links if match(st(l["dst"]))), lang)
    if kind == "images-all":
        recs = {**c.images, **c.pages}
        return _csv("todas-as-imagens", ["Página", "Imagem", "Alt", "Tem width/height", "Código", "Tamanho (KB)"],
                    ([r["page"], r["src"], tr(lang, "(sem atributo)") if r["alt"] is None else r["alt"], r.get("sized", ""),
                      (recs.get(r["src"]) or {}).get("status"), round(((recs.get(r["src"]) or {}).get("size") or 0) / 1024, 1)]
                     for r in c.image_refs), lang)
    if kind == "hreflang":
        rows = []
        for p in list(c.pages.values()):
            for code, href in p.get("_hreflang") or []:
                t = c.pages.get(href)
                rows.append([p["url"], code, href, st(href), bool(t and p["url"] in {h for _, h in t.get("_hreflang") or []})])
        return _csv("hreflang", ["Página", "Idioma", "URL hreflang", "Código", "Tem link de retorno"], rows, lang)
    if kind == "structured-data":
        return _csv("dados-estruturados", ["Página", "Formato", "Tipos", "Erros", "Avisos", "Erro de parse"],
                    ([p["url"], s.get("format"), ", ".join(map(str, s.get("types") or [])), "; ".join(s.get("missing") or []),
                      "; ".join(s.get("warnings") or []), s.get("error", "")] for p in list(c.pages.values()) for s in p.get("_sd") or []), lang)
    if kind == "cookies":
        return _csv("cookies", ["Nome", "Domínio", "Caminho", "Expira", "Secure", "HttpOnly", "SameSite", "Origem", "Terceiros", "Páginas", "Primeira URL"],
                    ([r["name"], r["domain"], r["path"], tr(lang, r["expires"]), r["secure"], r["httponly"], r["samesite"],
                      tr(lang, r["source"]), r["third_party"], r["pages"], r["url"]] for r in c.cookie_rows()), lang)
    if kind == "accessibility":
        return _csv("acessibilidade", ["Página", "Regra", "Impacto", "Descrição", "Elementos", "Seletores"],
                    ([p["url"], v["id"], v["impact"], v["help"], v["nodes"], " | ".join(v.get("targets") or [])]
                     for p in list(c.pages.values()) for v in p.get("_a11y") or []), lang)
    if kind == "headers":
        return _csv("cabecalhos-http", ["Página", "Cabeçalho", "Valor"],
                    ([p["url"], k, v] for p in list(c.pages.values()) for k, v in (p.get("_headers") or {}).items()), lang)
    raise HTTPException(404, "Exportação desconhecida")


@app.get("/api/report/{kind}.csv")
def report(kind: str, lang: str = "pt"):
    out = _report(current(), kind, lang)
    usage_add(lambda m: _usage_count(m, "exports", "report:" + kind))
    return out


def _report(c, kind, lang="pt"):
    issues = c.analyze()
    pages = list(c.pages.values())
    if kind == "overview":
        total = len(pages) or 1
        return _csv("resumo-do-crawl", ["Problema", "Tipo", "Prioridade", "URLs", "% do total"],
                    ([tr(lang, i["name"]), tr(lang, i["type"]), tr(lang, i["priority"]), i["count"], round(i["count"] / total * 100, 2)]
                     for i in issues if i["count"]), lang)
    if kind == "redirect-chains":
        rows = []
        for p in pages:
            if not p["redirect_url"]:
                continue
            chain, loop = c.redirect_chain(p["url"])
            if loop or not any(l["dst"] == p["url"] and l["kind"] == "redirect" for l in c.links):
                rows.append([p["url"], len(chain) - 1, " → ".join(chain), chain[-1], c._status_of(chain[-1]), loop])
        return _csv("cadeias-de-redirect", ["URL inicial", "Saltos", "Cadeia", "Destino final", "Código final", "Loop"], rows, lang)
    if kind == "canonical-chains":
        rows = []
        for p in pages:
            target = c.pages.get(p["canonical"]) if p["canonical"] and p["canonical"] != p["url"] else None
            if target and (target["status"] != 200 or (target["canonical"] and target["canonical"] != target["url"])):
                rows.append([p["url"], p["canonical"], target["status"], target["canonical"]])
        return _csv("cadeias-de-canonical", ["URL", "Canonical", "Código do canonical", "Canonical do canonical"], rows, lang)
    if kind == "insecure":
        return _csv("conteudo-inseguro", ["Página", "Recurso HTTP"],
                    ([p["url"], u] for p in pages for u in p.get("_mixed", [])), lang)
    if kind == "migration":
        seeds = c.seeds if c.cfg.mode == "list" else [p["url"] for p in pages if is_html(p) or p["redirect_url"]]
        rows = []
        for u in seeds:
            p = c.pages.get(u)
            if not p:
                rows.append([u, "", "", "", "", "", "", ""])
                continue
            chain, loop = c.redirect_chain(u)
            final = c.pages.get(chain[-1]) or {}
            rows.append([u, p["status"], chain[-1], final.get("status", ""), len(chain) - 1,
                         tr(lang, final.get("indexability", "")), final.get("title", ""), loop])
        return _csv("migracao", ["URL original", "Código", "Destino final", "Código final", "Saltos",
                                 "Indexabilidade final", "Title final", "Loop"], rows, lang)
    if kind == "orphans":
        return _csv("paginas-orfas", ["URL", "Código", "Indexabilidade"],
                    ([p["url"], p["status"], p["indexability"]] for p in pages if p["orphan"]), lang)
    if kind == "serp":
        return _csv("resumo-serp", ["URL", "Title", "Title (caracteres)", "Title (px)", "Meta description",
                                    "Description (caracteres)", "Description (px)"],
                    ([p["url"], p["title"], p["title_len"], p["title_px"], p["meta_desc"], p["md_len"], p["md_px"]]
                     for p in pages if is_html(p)), lang)
    if kind == "redirects-all":
        rows = []
        for p in pages:
            target = p["redirect_url"] or p.get("js_redirect") or (p.get("meta_refresh_url") if p.get("meta_refresh_url") != p["url"] else "")
            if not target:
                continue
            kind_ = "HTTP" if p["redirect_url"] else "JavaScript" if p.get("js_redirect") else "Meta refresh"
            chain, loop = c.redirect_chain(p["url"]) if p["redirect_url"] else ([p["url"], target], False)
            rows.append([p["url"], p["status"], kind_, target, len(chain) - 1, chain[-1], c._status_of(chain[-1]),
                         loop, p["unique_inlinks"]])
        return _csv("todos-os-redirects", ["URL", "Código", "Tipo", "Redireciona para", "Saltos", "Destino final",
                                          "Código final", "Loop", "Inlinks únicos"], rows, lang)
    if kind == "redirect-canonical-chains":
        rows = []

        def nxt(p):
            if p.get("redirect_url"):
                return p["redirect_url"], "Redirect"
            if p.get("js_redirect"):
                return p["js_redirect"], "Redirect JS"
            if p.get("meta_refresh_url") and p["meta_refresh_url"] != p["url"]:
                return p["meta_refresh_url"], "Meta refresh"
            if p.get("canonical") and p["canonical"] != p["url"]:
                return p["canonical"], "Canonical"
            return None, None
        for p in pages:
            chain, kinds, seen, cur, loop = [p["url"]], [], {p["url"]}, p, False
            while cur is not None and len(chain) <= 20:
                u, k = nxt(cur)
                if not u:
                    break
                kinds.append(k)
                if u in seen:
                    loop = True
                    chain.append(u)
                    break
                chain.append(u)
                seen.add(u)
                cur = c.pages.get(u)
            if len(chain) > 2 or loop:
                rows.append([p["url"], len(chain) - 1, " → ".join(chain), ", ".join(dict.fromkeys(kinds)), chain[-1],
                             c._status_of(chain[-1]), (c.pages.get(chain[-1]) or {}).get("indexability", ""), loop])
        return _csv("cadeias-redirect-e-canonical", ["URL inicial", "Saltos", "Cadeia", "Tipos", "Destino final", "Código final",
                                                     "Indexabilidade final", "Loop"], rows, lang)
    if kind == "non-indexable-canonicals":
        rows = []
        for p in pages:
            if p.get("canonical_nonindexable"):
                t_ = c.pages.get(p["canonical"]) or {}
                rows.append([p["url"], p["canonical"], t_.get("status"), tr(lang, t_.get("indexability", "")),
                             tr(lang, t_.get("indexability_reason", ""))])
        return _csv("canonicals-nao-indexaveis", ["URL", "Canonical", "Código do canonical", "Indexabilidade do canonical",
                                                  "Motivo"], rows, lang)
    if kind == "pagination":
        rows = []
        for p in pages:
            linked = {l["dst"] for l in c.links if l["src"] == p["url"] and l["kind"] == "a"} if (p["pag_next"] or p["pag_prev"]) else set()
            for rel in ("next", "prev"):
                u = p[f"pag_{rel}"]
                if u:
                    st = c._status_of(u)
                    t_ = c.pages.get(u) or {}
                    rows.append([p["url"], rel, u, st, tr(lang, t_.get("indexability", "")), u in linked,
                                 st is not None and st != 200, u not in linked])
        return _csv("paginacao", ["Página", "rel", "URL de paginação", "Código", "Indexabilidade", "Tem link <a>",
                                  "Não-200", "Sem link"], rows, lang)
    if kind == "hreflang-issues":
        rows = []
        a_dst = {l["dst"] for l in c.links if l["kind"] == "a" and l["internal"]}
        for p in pages:
            for code, href in p.get("_hreflang") or []:
                t_ = c.pages.get(href)
                probs = []
                st = c._status_of(href)
                if st is not None and st != 200:
                    probs.append("destino não-200")
                if t_ is not None and href != p["url"] and p["url"] not in {h for _, h in t_.get("_hreflang") or []}:
                    probs.append("sem retorno")
                if href != p["url"] and href not in a_dst:
                    probs.append("URL sem link interno")
                if t_ is not None and t_.get("canonical") and t_["canonical"] != href:
                    probs.append("destino não canônico")
                if t_ is not None and t_.get("indexability_reason") == "Noindex":
                    probs.append("destino noindex")
                if probs:
                    rows.append([p["url"], code, href, st, ", ".join(tr(lang, x) for x in probs)])
        return _csv("hreflang-problemas", ["Página", "Idioma", "URL hreflang", "Código", "Problemas"], rows, lang)
    if kind == "structured-data-summary":
        agg = {}
        for p in pages:
            for s in p.get("_sd") or ():
                for kind_, msgs in (("Erro", s.get("missing") or []), ("Aviso", s.get("warnings") or [])):
                    for m in set(msgs):
                        g = agg.setdefault((kind_, m), set())
                        g.add(p["url"])
                if s.get("error"):
                    agg.setdefault(("Erro de parse", s["error"][:200]), set()).add(p["url"])
        return _csv("resumo-dados-estruturados", ["Tipo", "Mensagem", "Páginas", "Exemplo"],
                    ([tr(lang, k), m, len(us), sorted(us)[0]] for (k, m), us in sorted(agg.items(), key=lambda kv: -len(kv[1]))), lang)
    if kind == "crawl-paths":
        rows = []
        for p in pages:
            path_, cur, seen = [p["url"]], p["url"], {p["url"]}
            while c.parent.get(cur) and len(path_) < 50:
                cur = c.parent[cur]
                if cur in seen:
                    break
                seen.add(cur)
                path_.append(cur)
            rows.append([p["url"], p["depth"], " ← ".join(path_[1:])])
        return _csv("caminhos-de-rastreamento", ["URL", "Profundidade", "Caminho (de onde veio)"], rows, lang)
    if kind == "accessibility-summary":
        return _csv("resumo-acessibilidade", ["Regra", "Impacto", "Descrição", "Páginas", "Elementos"],
                    ([a["id"], a["impact"], a["help"], a["pages"], a["nodes"]] for a in c.a11y_summary()), lang)
    if kind == "headers-summary":
        with_h = [p for p in pages if p.get("_headers")]
        cnt = Counter(k.lower() for p in with_h for k in p["_headers"])
        return _csv("resumo-cabecalhos", ["Cabeçalho", "Páginas", "% das páginas"],
                    ([k, n, round(n / (len(with_h) or 1) * 100, 2)] for k, n in cnt.most_common()), lang)
    if kind == "cookie-summary":
        return _bulk(c, "cookies", lang)
    if kind == "psi-opportunities":
        agg = {}
        for p in pages:
            for a in p.get("_psi_audits") or ():
                g = agg.setdefault(a["id"], [a["title"], a["kind"], 0, 0])
                g[2] += 1
                g[3] += a["savings_ms"] or 0
        return _csv("oportunidades-pagespeed", ["Auditoria", "Título", "Tipo", "Páginas", "Economia total (ms)"],
                    ([k, v[0], tr(lang, v[1]), v[2], v[3]] for k, v in sorted(agg.items(), key=lambda kv: -kv[1][2])), lang)
    raise HTTPException(404, "Relatório desconhecido")


# ---------- exports ----------
def _cell(v):
    if isinstance(v, list):
        v = "; ".join(map(str, v))
    if isinstance(v, str):
        v = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", v)
    return v


@app.get("/api/export.xlsx")
def export_xlsx(lang: str = "pt"):
    out = _xlsx(current(), lang)
    usage_add(lambda m: _usage_count(m, "exports", "xlsx"))
    return out


def _xlsx(c, lang="pt"):
    snap = c.snapshot()
    ai_keys = sorted({k for p in snap["pages"] for k in p if k.startswith("ai_") and p[k] is not None})
    ex_keys = [f"ex{i}" for i in range(1, len(snap["extractors"]) + 1)] + \
        [f"js{i}" for i in range(1, len(snap["custom_js"]) + 1)] + \
        [f"cs{i}" for i in range(1, len(snap["custom_search"]) + 1)] + ai_keys
    wb = Workbook(write_only=True)
    sheets = [(tr(lang, "Internos"), snap["pages"], PAGE_COLUMNS + ex_keys, PAGE_COLUMNS + snap["extractors"] + snap["custom_js"] + [s["name"] for s in snap["custom_search"]] + ai_keys),
              (tr(lang, "Externos"), snap["external"], EXTERNAL_COLUMNS, EXTERNAL_COLUMNS),
              (tr(lang, "Imagens"), snap["images"], IMAGE_COLUMNS, IMAGE_COLUMNS),
              ("Links", c.links, LINK_COLUMNS, LINK_COLUMNS)]
    for title, rows, cols, header in sheets:
        ws = wb.create_sheet(title)
        ws.append(header)
        for r in rows:
            ws.append([_cell(r.get(k)) for k in cols])
    ws = wb.create_sheet(tr(lang, "Quase duplicados"))
    ws.append(["URL", tr(lang, "URL semelhante"), tr(lang, "Similaridade %")])
    for u, lst in c.near_dups.items():
        for other, sim in lst:
            if u < other:
                ws.append([u, other, sim])
    ws = wb.create_sheet(tr(lang, "Problemas"))
    ws.append([tr(lang, h) for h in ("Problema", "Tipo", "Prioridade", "Qtd. URLs", "URLs")])
    for i in snap["issues"]:
        if i["count"]:
            ws.append([tr(lang, i["name"]), tr(lang, i["type"]), tr(lang, i["priority"]), i["count"], _cell(i["urls"][:500])])
    buf = io.BytesIO()
    wb.save(buf)
    return Response(buf.getvalue(),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": 'attachment; filename="seo-spider.xlsx"'})


class SitemapOptions(BaseModel):
    include_pdf: bool = False
    include_noindex: bool = False
    lastmod: str = Field("none", pattern="^(none|crawl|server)$")
    priority: str = Field("none", pattern="^(none|depth|fixed)$")
    priority_value: float = Field(0.5, ge=0, le=1)
    changefreq: str = Field("none", pattern="^(none|always|hourly|daily|weekly|monthly|yearly|never)$")
    images: bool = False
    max_per_file: int = Field(50000, ge=100, le=50000)


@app.post("/api/sitemap")
def sitemap_options(opts: SitemapOptions):
    """XML Sitemap generator (SF: Sitemaps > XML Sitemap) — returns one XML or a ZIP with an index."""
    import zipfile
    from email.utils import parsedate_to_datetime
    c = current()
    today = date.today().isoformat()
    urls = []
    for p in c.pages.values():
        ok = p["status"] == 200 and (p["content_type"] == "text/html" or (opts.include_pdf and p["content_type"] == "application/pdf"))
        if ok and (p["indexability"] == "Indexable" or (opts.include_noindex and p["indexability_reason"] == "Noindex")):
            urls.append(p)
    urls.sort(key=lambda p: ((p["depth"] if p["depth"] is not None else 99), p["url"]))
    imgs = defaultdict(list)
    if opts.images:
        for r in c.image_refs:
            if c.is_internal(r["src"]) and r["src"] not in imgs[r["page"]]:
                imgs[r["page"]].append(r["src"])

    def entry(p):
        out = [f"  <url>\n    <loc>{escape(p['url'])}</loc>"]
        if opts.lastmod == "crawl":
            out.append(f"    <lastmod>{today}</lastmod>")
        elif opts.lastmod == "server":
            lm = (p.get("_headers") or {}).get("last-modified")
            try:
                out.append(f"    <lastmod>{parsedate_to_datetime(lm).date().isoformat()}</lastmod>") if lm else None
            except (TypeError, ValueError):
                pass
        if opts.changefreq != "none":
            out.append(f"    <changefreq>{opts.changefreq}</changefreq>")
        if opts.priority == "depth":
            out.append(f"    <priority>{max(0.1, 1.0 - 0.1 * (p['depth'] or 0)):.1f}</priority>")
        elif opts.priority == "fixed":
            out.append(f"    <priority>{opts.priority_value:.1f}</priority>")
        out += [f"    <image:image><image:loc>{escape(i)}</image:loc></image:image>" for i in imgs.get(p["url"], [])[:1000]]
        return "\n".join(out) + "\n  </url>\n"

    ns = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"' + (' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"' if opts.images else "")
    chunks = [urls[i:i + opts.max_per_file] for i in range(0, len(urls), opts.max_per_file)] or [[]]
    files = [f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset {ns}>\n' + "".join(entry(p) for p in ch) + "</urlset>\n" for ch in chunks]
    if len(files) == 1:
        return Response(files[0], media_type="application/xml", headers={"Content-Disposition": 'attachment; filename="sitemap.xml"'})
    from urllib.parse import urlparse
    root = "{0.scheme}://{0.netloc}/".format(urlparse(c.start_url))
    index = ('<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
             + "".join(f"  <sitemap><loc>{root}sitemap-{i}.xml</loc><lastmod>{today}</lastmod></sitemap>\n" for i in range(1, len(files) + 1))
             + "</sitemapindex>\n")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("sitemap-index.xml", index)
        for i, f in enumerate(files, 1):
            z.writestr(f"sitemap-{i}.xml", f)
    return Response(buf.getvalue(), media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="sitemaps.zip"'})


@app.get("/api/sitemap.xml")
def sitemap():
    today = date.today().isoformat()
    body = "".join(f"  <url><loc>{escape(u)}</loc><lastmod>{today}</lastmod></url>\n"
                   for u in current().sitemap_urls_out())
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + body + "</urlset>\n")
    return Response(xml, media_type="application/xml",
                    headers={"Content-Disposition": 'attachment; filename="sitemap.xml"'})




# ---------- scheduling (File > Scheduling) and file exports shared with the CLI ----------
DATA_DIR = Path(__file__).parent / "data"
SCHED_FILE = DATA_DIR / "schedules.json"
EXPORT_DIR = DATA_DIR / "exports"
SCHED = {"running": None, "task": None}


def _csv_empty(body):
    """True when a CSV export has only its header row (Skip Empty Reports)."""
    rows = list(csv.reader(io.StringIO(body.decode("utf-8-sig", errors="replace"))))
    return len([r for r in rows[1:] if any(cell.strip() for cell in r)]) == 0


def export_files(c, kinds, outdir, lang="pt", skip_empty=False):
    """Write exports for a finished crawl: 'xlsx', bulk kinds ('issues', 'all-links', …) or 'report:<kind>'."""
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    written = []
    for k in kinds:
        if k == "xlsx":
            body, name = _xlsx(c, lang).body, "crawl.xlsx"
        elif k.startswith("report:"):
            body, name = _report(c, k[7:], lang).body, k[7:] + ".csv"
        else:
            body, name = _bulk(c, k, lang).body, k + ".csv"
        if skip_empty and name.endswith(".csv") and _csv_empty(body):
            continue
        (outdir / name).write_bytes(body)
        written.append(name)
    return written


def previous_in_project(c):
    """Most recent saved crawl of the same project (Auto Compare Crawls)."""
    for m in storage.list_crawls():
        if m["id"] != c.crawl_id and (m.get("project") or "") == (c.project or "") and m.get("status") != "running":
            try:
                return storage.load(m["id"])
            except (OSError, ValueError, KeyError):
                continue
    return None


def compare_files(prev, curr, outdir, lang="pt", skip_empty=False):
    """Write the comparison between two crawls (issues diff + change detection) and return (files, summary)."""
    cmp = storage.compare(prev, curr)
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    files = []
    iss = _csv("comparacao-problemas", ["Problema", "Tipo", "Prioridade", "Anterior", "Atual", "Mudança",
                                        "Adicionadas", "Novas", "Removidas", "Ausentes"],
               ([tr(lang, i["name"]), tr(lang, i["type"]), tr(lang, i["priority"]), i["previous"], i["current"], i["change"],
                 len(i["added"]), len(i["new"]), len(i["removed"]), len(i["missing"])]
                for i in cmp["issues"]), lang).body
    chg = _csv("comparacao-mudancas", ["Elemento", "URL", "Anterior", "Atual"],
               ([tr(lang, ch["label"]), r["url"], r.get("before"), r.get("after")] for ch in cmp["changes"] for r in ch["rows"]), lang).body
    urls = _csv("comparacao-urls", ["URL", "Situação"],
                [[u, tr(lang, "Nova")] for u in cmp["new_urls"]] + [[u, tr(lang, "Ausente")] for u in cmp["missing_urls"]], lang).body
    for name, body in (("comparacao-problemas.csv", iss), ("comparacao-mudancas.csv", chg), ("comparacao-urls.csv", urls)):
        if skip_empty and _csv_empty(body):
            continue
        (outdir / name).write_bytes(body)
        files.append(name)
    summary = dict(previous=prev.crawl_id, previous_name=prev.crawl_name,
                   worse=sum(1 for i in cmp["issues"] if i["change"] > 0 and i["type"] == "Issue"),
                   better=sum(1 for i in cmp["issues"] if i["change"] < 0 and i["type"] == "Issue"),
                   new_urls=len(cmp["new_urls"]), missing_urls=len(cmp["missing_urls"]),
                   changed=sum(ch["count"] for ch in cmp["changes"]))
    return files, summary


class Schedule(BaseModel):
    id: str = ""
    name: str = Field("Crawl agendado", min_length=1, max_length=100)
    enabled: bool = True
    frequency: str = Field("daily", pattern="^(once|daily|weekly|monthly)$")
    date: str = ""
    time: str = Field("03:00", pattern=r"^\d{2}:\d{2}$")
    weekday: int = Field(0, ge=0, le=6)   # Monday = 0
    day: int = Field(1, ge=1, le=28)
    project: str = ""
    config: CrawlRequest
    exports: list[str] = []
    output_dir: str = ""
    lang: str = Field("pt", pattern="^(pt|en|es)$")
    auto_compare: bool = False    # compare with the most recent crawl of the same project
    skip_empty: bool = False      # don't write exports/reports without data


def _load_sched():
    try:
        return json.loads(SCHED_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def _save_sched(items):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SCHED_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")


def _next_run(s, now=None):
    from datetime import datetime, timedelta
    now = datetime.fromtimestamp(now or time.time())
    hh, mm = map(int, s["time"].split(":"))
    if s["frequency"] == "once":
        try:
            d = datetime.strptime(f'{s["date"]} {s["time"]}', "%Y-%m-%d %H:%M")
        except ValueError:
            return None
        return d.timestamp() if d > now else None
    cand = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    for _ in range(400):
        if cand > now and (s["frequency"] == "daily" or (s["frequency"] == "weekly" and cand.weekday() == s["weekday"])
                           or (s["frequency"] == "monthly" and cand.day == s["day"])):
            return cand.timestamp()
        cand += timedelta(days=1)
    return None


def _public_sched(s):
    cfg = dict(s["config"], auth_pass="")
    return dict(s, config=cfg)


async def _run_schedule(sid):
    s = next((x for x in _load_sched() if x["id"] == sid), None)
    if not s or SCHED["running"]:
        return
    SCHED["running"] = sid
    started, out, written, crawl_id, compared = time.time(), None, [], "", None
    try:
        c = make_crawler(CrawlRequest(**s["config"]))
        c.crawl_name = f'{s["name"]} — {time.strftime("%Y-%m-%d %H:%M")}'
        c.project = s.get("project") or s["name"]
        await c.run()
        await asyncio.to_thread(storage.save, c)
        crawl_id = c.crawl_id
        slug = re.sub(r"[^\w.-]+", "-", s["name"]).strip("-") or "crawl"
        out = (Path(s["output_dir"]) if s.get("output_dir") else EXPORT_DIR) / f'{slug}-{time.strftime("%Y%m%d-%H%M")}'
        if s.get("exports"):
            written = await asyncio.to_thread(export_files, c, s["exports"], out, s.get("lang", "pt"), s.get("skip_empty", False))
        if s.get("auto_compare") and c.status != "error":
            prev = await asyncio.to_thread(previous_in_project, c)
            if prev is not None:
                files, compared = await asyncio.to_thread(compare_files, prev, c, out, s.get("lang", "pt"), s.get("skip_empty", False))
                written += files
        status, err = c.status, c.error
    except Exception as e:
        status, err = "error", f"{type(e).__name__}: {getattr(e, 'detail', e)}"[:300]
    finally:
        SCHED["running"] = None
    items = _load_sched()
    for x in items:
        if x["id"] == sid:
            x.update(last_run=started, last_status=status, last_error=err, last_crawl=crawl_id,
                     last_output=str(out) if written else "", last_compare=compared)
            if x["frequency"] == "once":
                x["enabled"] = False
            x["next_run"] = _next_run(x) if x["enabled"] else None
    _save_sched(items)


async def _scheduler():
    while True:
        await asyncio.sleep(20)
        try:
            for s in _load_sched():
                if s.get("enabled") and s.get("next_run") and s["next_run"] <= time.time() and not SCHED["running"]:
                    await _run_schedule(s["id"])
        except Exception:
            pass


@app.on_event("startup")
async def _start_scheduler():
    SCHED["task"] = asyncio.create_task(_scheduler())


@app.get("/api/schedules")
def schedules_list():
    return dict(items=[_public_sched(s) for s in _load_sched()], running=SCHED["running"], export_dir=str(EXPORT_DIR),
                app_dir=str(Path(__file__).parent))


@app.post("/api/schedules")
def schedules_save(s: Schedule):
    d = s.model_dump()
    if not d["config"]["start_url"].strip() and not d["config"]["url_list"]:
        raise HTTPException(400, "Informe a URL inicial ou uma lista de URLs")
    items = _load_sched()
    old = next((x for x in items if x["id"] == s.id), None) if s.id else None
    if old:
        if not d["config"]["auth_pass"]:
            d["config"]["auth_pass"] = old["config"].get("auth_pass", "")
        for k in ("last_run", "last_status", "last_error", "last_crawl", "last_output", "last_compare"):
            d[k] = old.get(k)
    d["id"] = s.id or uuid.uuid4().hex[:10]
    d["next_run"] = _next_run(d) if d["enabled"] else None
    _save_sched([x for x in items if x["id"] != d["id"]] + [d])
    return _public_sched(d)


@app.delete("/api/schedules/{sid}")
def schedules_delete(sid: str):
    _save_sched([x for x in _load_sched() if x["id"] != sid])
    return {"ok": True}


@app.post("/api/schedules/{sid}/run")
async def schedules_run(sid: str):
    if SCHED["running"]:
        raise HTTPException(409, "Já existe um crawl agendado em execução")
    if not any(x["id"] == sid for x in _load_sched()):
        raise HTTPException(404, "Agendamento não encontrado")
    asyncio.create_task(_run_schedule(sid))
    return {"ok": True}


@app.middleware("http")
async def _no_stale_static(request, call_next):
    """Static files (app.js, style.css, i18n.json…) are revalidated on every load, so an update shows up
    without a hard refresh (the browser gets a cheap 304 when nothing changed)."""
    resp = await call_next(request)
    if not request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
