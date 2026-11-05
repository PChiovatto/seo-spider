"""Saved crawls (SF database storage mode) and crawl comparison (SF Compare mode / Change Detection).
Crawls are stored as gzipped JSON in data/crawls/ — a safe format, so importing a crawl file
received from someone else never executes code."""
import base64
import gzip
import json
import time
import uuid
from dataclasses import asdict
from pathlib import Path

import numpy as np

from analysis import is_html
from crawler import Crawler, CrawlConfig

DIR = Path(__file__).parent / "data" / "crawls"
INDEX = DIR / "index.json"
FORMAT = "seo-spider-crawl"
STATE_FIELDS = ["pages", "external", "images", "links", "image_refs", "parent", "sitemaps", "sitemap_urls",
                "_sitemap_seeds", "_extra_seeds", "sitemap_hits", "sitemap_info", "browser_cookies", "analysed", "skipped", "hsts_hosts", "robots_text", "api_urls", "near_dups",
                "finalized", "status", "started", "finished", "_seen", "error"]


# ---------- encoding (bytes, numpy, sets) ----------
def _default(o):
    if isinstance(o, (bytes, bytearray)):
        return {"__b": base64.b64encode(o).decode()}
    if isinstance(o, np.ndarray):
        return {"__np": base64.b64encode(o.tobytes()).decode(), "dtype": str(o.dtype), "shape": list(o.shape)}
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (set, frozenset)):
        return {"__set": list(o)}
    raise TypeError(f"not serialisable: {type(o).__name__}")


def _hook(d):
    if "__b" in d and len(d) == 1:
        return base64.b64decode(d["__b"])
    if "__np" in d:
        return np.frombuffer(base64.b64decode(d["__np"]), dtype=d["dtype"]).reshape(d["shape"]).copy()
    if "__set" in d and len(d) == 1:
        return set(d["__set"])
    return d


def _index():
    try:
        return json.loads(INDEX.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def _write_index(items):
    DIR.mkdir(parents=True, exist_ok=True)
    INDEX.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")


def list_crawls():
    return sorted(_index(), key=lambda m: m.get("saved", 0), reverse=True)


def _meta(c):
    pages = list(c.pages.values())
    return dict(id=c.crawl_id, name=c.crawl_name, project=c.project, start_url=c.start_url, mode=c.cfg.mode,
                started=c.started, finished=c.finished, saved=time.time(), status=c.status,
                urls=len(pages), html=sum(1 for p in pages if is_html(p)))


def serialise(c):
    cfg = asdict(c.cfg)
    cfg["extractors"] = [{k: v for k, v in e.items() if not k.startswith("_")} for e in cfg["extractors"]]
    cfg["custom_search"] = [{k: v for k, v in e.items() if not k.startswith("_")} for e in cfg["custom_search"]]
    cfg["auth_pass"] = ""  # never persist secrets
    cfg["auth_cookies"] = []
    cfg["auth_entries"] = []
    sem = c.semantic or {}
    state = {f: getattr(c, f) for f in STATE_FIELDS}
    state["semantic_meta"] = {"embedder": sem.get("embedder"), "key": sem.get("key")}
    payload = {"format": FORMAT, "version": 1, "meta": _meta(c), "cfg": cfg, "state": state}
    return gzip.compress(json.dumps(payload, default=_default, ensure_ascii=False).encode(), compresslevel=6)


def save(c):
    """Save (or overwrite) a crawl and update the index."""
    DIR.mkdir(parents=True, exist_ok=True)
    (DIR / f"{c.crawl_id}.json.gz").write_bytes(serialise(c))
    items = [m for m in _index() if m["id"] != c.crawl_id] + [_meta(c)]
    _write_index(items)
    return _meta(c)


def deserialise(blob):
    data = json.loads(gzip.decompress(blob).decode(), object_hook=_hook)
    if data.get("format") != FORMAT:
        raise ValueError("Arquivo de crawl inválido")
    known = set(CrawlConfig.__dataclass_fields__)
    c = Crawler(CrawlConfig(**{k: v for k, v in data["cfg"].items() if k in known}))
    for f, v in data["state"].items():
        if f in STATE_FIELDS:
            setattr(c, f, v)
    if "analysed" not in data["state"] and c.finalized:  # saved before crawl-analysis groups existed
        from analysis import ANALYSIS_GROUPS
        c.analysed = set(ANALYSIS_GROUPS)
    # crawls saved by older versions lack newer fields: fill them with the defaults
    for p in c.pages.values():
        for k, v in Crawler._blank(p["url"], p.get("depth")).items():
            p.setdefault(k, v)
    meta = data["meta"]
    c.crawl_id, c.crawl_name, c.project = meta["id"], meta.get("name", ""), meta.get("project", "")
    c.phase = ""
    if c.status == "running":
        c.status = "stopped"
    sm = data["state"].get("semantic_meta") or {}
    c._restore_semantic = sm  # rebuilt after loading (index is derived data)
    return c


def load(crawl_id):
    path = DIR / f"{crawl_id}.json.gz"
    if not path.exists():
        raise FileNotFoundError("Crawl não encontrado")
    c = deserialise(path.read_bytes())
    rebuild_derived(c)
    return c


def rebuild_derived(c):
    sm = getattr(c, "_restore_semantic", {}) or {}
    html_pages = [p for p in c.pages.values() if is_html(p)]
    if sm.get("key") and sm.get("embedder"):
        c.apply_embeddings(sm["key"], tuple(sm["embedder"]))
    elif c.cfg.semantic and c.finalized:
        c._semantic(html_pages)


def import_blob(blob):
    c = deserialise(blob)
    c.crawl_id = uuid.uuid4().hex[:12]  # imported copy gets its own id
    rebuild_derived(c)
    save(c)
    return c


def export_blob(crawl_id):
    path = DIR / f"{crawl_id}.json.gz"
    if not path.exists():
        raise FileNotFoundError("Crawl não encontrado")
    return path.read_bytes()


def update(crawl_id, name=None, project=None):
    items = _index()
    for m in items:
        if m["id"] == crawl_id:
            if name is not None:
                m["name"] = name
            if project is not None:
                m["project"] = project
    _write_index(items)
    return next((m for m in items if m["id"] == crawl_id), None)


def delete(crawl_id):
    (DIR / f"{crawl_id}.json.gz").unlink(missing_ok=True)
    _write_index([m for m in _index() if m["id"] != crawl_id])


# ---------- comparison (SF Compare mode + Change Detection) ----------
CHANGE_FIELDS = [
    ("indexability", "Indexabilidade"), ("title", "Page Titles"), ("meta_desc", "Meta Description"), ("h1_1", "H1"),
    ("word_count", "Contagem de palavras"), ("depth", "Profundidade de rastreamento"), ("inlinks", "Inlinks"),
    ("unique_inlinks", "Inlinks únicos"), ("outlinks", "Outlinks internos"), ("external_outlinks", "Outlinks externos"),
    ("sd_types", "Tipos de dados estruturados"), ("status", "Código de status"), ("canonical", "Canonical"),
]


def _content_changed(a, b, threshold=90.0):
    ma, mb = a.get("_minhash"), b.get("_minhash")
    if ma is not None and mb is not None and len(ma) == len(mb):
        sim = float((np.asarray(ma) == np.asarray(mb)).mean() * 100)
        return sim < threshold, round(sim, 1)
    return a.get("content_hash") != b.get("content_hash"), None


def compare(prev, curr, limit=20000):
    p_urls, c_urls = set(prev.pages), set(curr.pages)
    p_iss = {i["name"]: (i, set(i["urls"])) for i in prev.analyze()}
    c_iss = {i["name"]: (i, set(i["urls"])) for i in curr.analyze()}
    issues = []
    for name in dict.fromkeys(list(c_iss) + list(p_iss)):
        ci, cu = c_iss.get(name, (None, set()))
        pi, pu = p_iss.get(name, (None, set()))
        info = ci or pi
        if not cu and not pu:
            continue
        issues.append(dict(
            name=name, type=info["type"], priority=info["priority"], current=len(cu), previous=len(pu),
            change=len(cu) - len(pu),
            added=sorted((cu - pu) & p_urls)[:limit],      # in previous crawl, moved into the filter
            new=sorted((cu - pu) - p_urls)[:limit],        # not in previous crawl at all
            removed=sorted((pu - cu) & c_urls)[:limit],    # still crawled, moved out of the filter
            missing=sorted((pu - cu) - c_urls)[:limit],    # no longer in the crawl
        ))
    changes = {f: [] for f, _ in CHANGE_FIELDS}
    changes["content"] = []
    for u in sorted(p_urls & c_urls):
        a, b = prev.pages[u], curr.pages[u]
        for f, _ in CHANGE_FIELDS:
            if (a.get(f) or "") != (b.get(f) or ""):
                if len(changes[f]) < limit:
                    changes[f].append(dict(url=u, before=a.get(f), after=b.get(f)))
        if is_html(a) and is_html(b):
            changed, sim = _content_changed(a, b)
            if changed and len(changes["content"]) < limit:
                changes["content"].append(dict(url=u, before=a.get("word_count"), after=b.get("word_count"), similarity=sim))
    labels = dict(CHANGE_FIELDS, content="Conteúdo")
    return dict(
        previous=_meta(prev), current=_meta(curr), issues=issues,
        changes=[dict(field=f, label=labels[f], count=len(rows), rows=rows) for f, rows in changes.items()],
        new_urls=sorted(c_urls - p_urls)[:limit], missing_urls=sorted(p_urls - c_urls)[:limit],
    )
