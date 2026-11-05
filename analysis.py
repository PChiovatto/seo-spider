"""SEO analysis helpers: pixel widths, MinHash near-duplicates, link score,
structured-data checks and issue rules."""
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urlparse

import numpy as np

# ---------- pixel width (Arial, units per 1000 em, ASCII 32..126) ----------
_ARIAL = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]
TITLE_PX_LIMIT = 580   # Google SERP title, 20px Arial
DESC_PX_LIMIT = 920    # Google SERP description, 14px Arial


def pixel_width(text, size):
    return round(sum(_ARIAL[ord(c) - 32] if 32 <= ord(c) <= 126 else 556 for c in text) * size / 1000)


# ---------- MinHash near-duplicates ----------
_P = (1 << 31) - 1
_rng = np.random.default_rng(42)
_A = _rng.integers(1, _P, 128, dtype=np.uint64)
_B = _rng.integers(0, _P, 128, dtype=np.uint64)
_BANDS, _ROWS = 32, 4


def minhash(text):
    words = re.findall(r"\w+", text.lower())
    if len(words) < 5:
        return None
    shingles = {" ".join(words[i:i + 3]) for i in range(len(words) - 2)}
    h = np.fromiter(
        (int.from_bytes(hashlib.blake2b(s.encode(), digest_size=4).digest(), "little") & _P for s in shingles),
        dtype=np.uint64, count=len(shingles))
    return ((h[:, None] * _A + _B) % _P).min(axis=0).astype(np.uint32)


def near_duplicates(items, threshold):
    """items: [(url, signature)] -> {url: [(other_url, similarity%)]} sorted by similarity."""
    if len(items) < 2:
        return {}
    sigs = np.stack([s for _, s in items])
    buckets = defaultdict(list)
    for i in range(len(items)):
        for b in range(_BANDS):
            buckets[(b, sigs[i, b * _ROWS:(b + 1) * _ROWS].tobytes())].append(i)
    cand = defaultdict(set)
    for ids in buckets.values():
        for x in range(len(ids)):
            for y in ids[x + 1:]:
                cand[ids[x]].add(y)
    out = defaultdict(list)
    for i, js in cand.items():
        js = np.fromiter(js, dtype=np.int64)
        sims = (sigs[js] == sigs[i]).mean(axis=1) * 100
        for j, sim in zip(js, sims):
            if sim >= threshold:
                sim = round(float(sim), 1)
                out[items[i][0]].append((items[j][0], sim))
                out[items[j][0]].append((items[i][0], sim))
    for v in out.values():
        v.sort(key=lambda x: -x[1])
    return dict(out)


# ---------- spelling (offline dictionaries via pyspellchecker) ----------
SPELL_LANGS = {"pt", "en", "es", "fr", "de", "it", "nl", "ru", "ar", "lv", "eu", "fa"}
WORD_RE = re.compile(r"\b[^\W\d_]{3,}\b")
_SPELLERS = {}


def speller(lang):
    if lang not in _SPELLERS:
        from spellchecker import SpellChecker
        _SPELLERS[lang] = SpellChecker(language=lang, case_sensitive=False)
    return _SPELLERS[lang]


def misspelled(text, lang, ignore):
    """Lower-case words unknown to the dictionary. Capitalised and all-caps words
    (proper nouns, acronyms, brand names) are skipped to keep noise low."""
    words = {w.lower() for w in WORD_RE.findall(text) if not w[0].isupper()}
    return sorted(speller(lang).unknown(words - ignore))


# ---------- semantic index (TF-IDF + LSA, fully local) ----------
TOKEN_RE = re.compile(r"[^\W\d_]{3,}")


def _rsvd(X, k, oversample=10, iters=2):
    rng = np.random.default_rng(0)
    Y = X @ rng.standard_normal((X.shape[1], k + oversample)).astype(np.float32)
    for _ in range(iters):
        Y = X @ (X.T @ Y)
    Q, _ = np.linalg.qr(Y)
    Ub, S, Vt = np.linalg.svd(Q.T @ X, full_matrices=False)
    return (Q @ Ub)[:, :k], S[:k], Vt[:k]


def _normalize(M):
    n = np.linalg.norm(M, axis=-1, keepdims=True)
    n[n == 0] = 1
    return M / n


def semantic_index(docs, dims=100, vocab_size=5000):
    tokens = [TOKEN_RE.findall(d.lower()) for d in docs]
    n = len(docs)
    df = Counter()
    for t in tokens:
        df.update(set(t))
    min_df = 2 if n >= 5 else 1
    vocab = [w for w, c in df.most_common() if c >= min_df][:vocab_size]
    idx = {w: i for i, w in enumerate(vocab)}
    X = np.zeros((n, len(vocab)), dtype=np.float32)
    for i, t in enumerate(tokens):
        for w, c in Counter(t).items():
            j = idx.get(w)
            if j is not None:
                X[i, j] = 1 + np.log(c)
    idf = (np.log((1 + n) / (1 + np.array([df[w] for w in vocab], dtype=np.float32))) + 1).astype(np.float32)
    X = _normalize(X * idf)
    k = min(dims, n - 1, len(vocab) - 1)
    Vt = None
    E = X
    if k >= 2:
        U, S, Vt = _rsvd(X, k)
        E = U * S
    return dict(vocab=idx, idf=idf, Vt=Vt, E=_normalize(E).astype(np.float32))


def semantic_embed(index, text):
    q = np.zeros(len(index["vocab"]), dtype=np.float32)
    for w, c in Counter(TOKEN_RE.findall(text.lower())).items():
        j = index["vocab"].get(w)
        if j is not None:
            q[j] = 1 + np.log(c)
    q = _normalize(q * index["idf"])
    if index["Vt"] is not None:
        q = _normalize(q @ index["Vt"].T)
    return q


def semantic_pairs(E, threshold, top=20, chunk=512):
    """For each row: (count above threshold, best other index, best score, top list)."""
    n = len(E)
    out = []
    for s in range(0, n, chunk):
        sims = E[s:s + chunk] @ E.T
        for r, row in enumerate(sims):
            i = s + r
            row[i] = -1
            order = np.argsort(-row)[:top]
            out.append((int((row >= threshold).sum()), int(order[0]), float(row[order[0]]),
                        [(int(j), float(row[j])) for j in order if row[j] >= threshold]))
    return out


# ---------- link score (internal PageRank, 0-100 log scale) ----------
def link_score(nodes, edges, iterations=30, d=0.85):
    n = len(nodes)
    if not n:
        return {}
    idx = {u: i for i, u in enumerate(nodes)}
    out = defaultdict(set)
    for s, t in edges:
        if s in idx and t in idx and s != t:
            out[idx[s]].add(idx[t])
    src, dst, w = [], [], []
    for s, ts in out.items():
        for t in ts:
            src.append(s)
            dst.append(t)
            w.append(1 / len(ts))
    src, dst, w = np.array(src, dtype=np.int64), np.array(dst, dtype=np.int64), np.array(w)
    dangling = np.array([i not in out for i in range(n)])
    pr = np.full(n, 1 / n)
    for _ in range(iterations):
        new = np.zeros(n)
        np.add.at(new, dst, pr[src] * w)
        pr = (1 - d) / n + d * (new + pr[dangling].sum() / n)
    lp = np.log(pr)
    lo, hi = lp.min(), lp.max()
    scores = (lp - lo) / (hi - lo) * 100 if hi > lo else np.full(n, 100.0)
    return {u: int(round(scores[i])) for u, i in idx.items()}


# ---------- structured data ----------
SCHEMA_URL = "https://schema.org/version/latest/schemaorg-current-https.jsonld"
_VOCAB_PATH = Path(__file__).parent / "data" / "schemaorg.json"
_VOCAB = {"loaded": False, "data": None}


def _ids(v):
    v = v if isinstance(v, list) else [v] if v else []
    return [x["@id"].split(":", 1)[-1] for x in v if isinstance(x, dict) and "@id" in x]


def schema_vocab():
    """Schema.org vocabulary (types with their parents, properties with their domains).
    Downloaded once from schema.org and cached in data/schemaorg.json; None when offline."""
    if _VOCAB["loaded"]:
        return _VOCAB["data"]
    _VOCAB["loaded"] = True
    try:
        _VOCAB["data"] = json.loads(_VOCAB_PATH.read_text(encoding="utf-8"))
        return _VOCAB["data"]
    except (OSError, ValueError):
        pass
    try:
        import httpx
        graph = httpx.get(SCHEMA_URL, timeout=60, follow_redirects=True).json()["@graph"]
    except Exception:
        return None
    types, props = {}, {}
    for node in graph:
        kind = node.get("@type")
        kinds = kind if isinstance(kind, list) else [kind]
        name = str(node.get("@id", "")).split(":", 1)[-1]
        if "rdfs:Class" in kinds:
            types[name] = _ids(node.get("rdfs:subClassOf"))
        elif "rdf:Property" in kinds:
            props[name] = _ids(node.get("schema:domainIncludes"))
        elif any(isinstance(k, str) and k.startswith("schema:") for k in kinds):
            types.setdefault(name, [k.split(":", 1)[-1] for k in kinds if isinstance(k, str)])  # enumeration members
    data = {"types": types, "props": props}
    try:
        _VOCAB_PATH.parent.mkdir(exist_ok=True)
        _VOCAB_PATH.write_text(json.dumps(data), encoding="utf-8")
    except OSError:
        pass
    _VOCAB["data"] = data
    return data


def _ancestors(t, vocab, _seen=None):
    seen = _seen if _seen is not None else set()
    if t in seen:
        return seen
    seen.add(t)
    for parent in (vocab or {}).get("types", {}).get(t, []):
        _ancestors(parent, vocab, seen)
    return seen


# Google rich result requirements: type -> (required, recommended, one_of groups)
GOOGLE_RULES = {
    "Article": ([], ["headline", "image", "datePublished", "author"], []),
    "Product": (["name"], ["image", "description", "brand", "sku"], [["offers", "review", "aggregateRating"]]),
    "Offer": ([], ["availability", "url"], [["price", "priceSpecification"]]),
    "AggregateRating": (["ratingValue"], ["bestRating"], [["ratingCount", "reviewCount"]]),
    "Review": (["author", "reviewRating"], ["datePublished"], []),
    "BreadcrumbList": (["itemListElement"], [], []),
    "ListItem": (["position"], ["name", "item"], []),
    "FAQPage": (["mainEntity"], [], []),
    "Question": (["name", "acceptedAnswer"], [], []),
    "Answer": (["text"], [], []),
    "LocalBusiness": (["name", "address"], ["telephone", "url", "geo", "openingHoursSpecification", "priceRange", "image"], []),
    "Organization": ([], ["name", "url", "logo"], []),
    "Event": (["name", "startDate", "location"], ["endDate", "image", "description", "offers", "organizer", "eventStatus"], []),
    "Recipe": (["name", "image"], ["author", "datePublished", "description", "recipeIngredient", "recipeInstructions", "totalTime"], []),
    "VideoObject": (["name", "thumbnailUrl", "uploadDate"], ["description", "duration", "contentUrl"], []),
    "JobPosting": (["title", "datePosted", "description", "hiringOrganization"], ["validThrough", "employmentType", "baseSalary", "jobLocation"], []),
    "HowTo": (["name", "step"], ["image", "totalTime"], []),
    "SoftwareApplication": (["name"], ["operatingSystem", "applicationCategory", "offers"], [["aggregateRating", "review"]]),
    "Course": (["name", "description"], ["provider"], []),
    "ImageObject": (["contentUrl"], ["license", "creator"], []),
    "WebSite": ([], ["name", "url"], []),
    "Person": ([], ["name"], []),
}


def walk_jsonld(obj):
    if isinstance(obj, list):
        for x in obj:
            yield from walk_jsonld(x)
    elif isinstance(obj, dict):
        if "@type" in obj:
            yield obj
        for k, v in obj.items():
            if k != "@context":
                yield from walk_jsonld(v)


def _types(node):
    t = node.get("@type")
    return [str(x).split(":", 1)[-1].split("/")[-1] for x in (t if isinstance(t, list) else [t])] if t else []


def validate_entity(node, vocab):
    """Returns (errors, warnings) for one JSON-LD entity: Schema.org vocabulary + Google rich results."""
    errors, warnings = [], []
    types = _types(node)
    lineage = set()
    for t in types:
        if vocab and t not in vocab["types"]:
            errors.append(f"{t}: tipo desconhecido no Schema.org")
        lineage |= _ancestors(t, vocab) if vocab else {t}
    if vocab:
        for key in node:
            if key.startswith("@"):
                continue
            prop = key.split(":", 1)[-1]
            if prop not in vocab["props"]:
                errors.append(f"{'/'.join(types)}.{prop}: propriedade desconhecida no Schema.org")
            elif lineage and vocab["props"][prop] and not lineage & set(vocab["props"][prop]):
                warnings.append(f"{'/'.join(types)}.{prop}: propriedade não esperada para este tipo")
    for rule_type, (required, recommended, one_of) in GOOGLE_RULES.items():
        if rule_type in lineage:
            label = "/".join(types)
            errors += [f"{label}.{p}: obrigatório (Google)" for p in required if p not in node]
            errors += [f"{label}: precisa de {' / '.join(g)} (Google)" for g in one_of if not any(p in node for p in g)]
            warnings += [f"{label}.{p}: recomendado (Google)" for p in recommended if p not in node]
    return list(dict.fromkeys(errors)), list(dict.fromkeys(warnings))


def check_entity(node):
    """Backwards-compatible: Google-required properties missing on this entity."""
    return [e for e in validate_entity(node, None)[0]]


# ---------- semantic cluster map ----------
def semantic_map(index, k=None):
    """2-D projection (PCA) + k-means clusters of the semantic index for the content cluster diagram."""
    E = index["E"]
    n = len(E)
    X = E - E.mean(axis=0)
    _, _, vt = np.linalg.svd(X, full_matrices=False)
    xy = X @ vt[:2].T
    k = k or max(2, min(8, n // 12))
    rng = np.random.default_rng(1)
    cent = E[rng.choice(n, size=min(k, n), replace=False)]
    for _ in range(25):
        labels = (E @ cent.T).argmax(axis=1)
        new = np.stack([E[labels == c].mean(axis=0) if (labels == c).any() else cent[c] for c in range(len(cent))])
        new /= np.maximum(np.linalg.norm(new, axis=1, keepdims=True), 1e-9)
        if np.allclose(new, cent):
            break
        cent = new
    vocab = sorted(index["vocab"], key=index["vocab"].get) if index.get("vocab") else []
    names = []
    for c in range(len(cent)):
        if index.get("Vt") is not None and vocab:
            weights = cent[c] @ index["Vt"]
            top = [vocab[i] for i in np.argsort(-weights)[:3]]
        else:
            top = []
        names.append(", ".join(top) or f"Cluster {c + 1}")
    return [dict(x=float(xy[i, 0]), y=float(xy[i, 1]), cluster=int(labels[i])) for i in range(n)], names


# ---------- issues ----------
LANG_RE = re.compile(r"^(x-default|[a-z]{2,3}(-([a-z]{4}|[a-z]{2}|\d{3}))?)$", re.I)


def is_blocked(r):
    return r["status"] == 0 and r["status_text"].startswith("Bloqueado")


def is_broken(r):
    s = r["status"]
    return s is not None and (s >= 400 or (s == 0 and not is_blocked(r)))


def is_html(p):
    return p["status"] == 200 and p["content_type"] == "text/html"


def _path(p):
    return urlparse(p["url"]).path


# (name, type, priority, scope, predicate) — scope: page | html | external | image
# Spider > Preferences (thresholds used by filters and issues)
DEFAULT_PREFS = dict(title_px_min=200, title_px_max=561, title_min=30, title_max=60,
                     md_px_min=400, md_px_max=985, md_min=70, md_max=155,
                     ext_outlinks=10, int_outlinks=1000, deep=3,
                     url_max=115, h1_max=70, h2_max=70, alt_max=100, img_kb=100, low_words=200, slow_s=1)
PREFS = dict(DEFAULT_PREFS)
DEFAULT_WEAK_ANCHORS = ["click here", "click this", "find out more", "go", "here", "learn more", "more", "over here",
                        "read here", "read more", "right here", "start", "this", "clique aqui", "aqui", "saiba mais",
                        "leia mais", "veja mais", "mais", "ver mais", "este link"]
DEFAULT_SOFT404 = ["404 Not Found", "404 error", "410 Not Found", "can't find the page", "can't seem to find that page",
                   "couldn't find that page", "couldn't find the page", "couldn't find what you're looking for",
                   "error 404", "error occurred", "no products found", "no results found", "not found",
                   "nothing found", "oops", "page not found", "page you requested could not be found",
                   "this page doesn't exist", "we can't find", "página não encontrada", "não encontrada",
                   "nada encontrado", "página no encontrada", "no encontrada"]
# Spider > Extraction: issues that only make sense when the data is extracted
EXTRACT_RULES = [("Title", "ex_title"), ("Meta description", "ex_meta_desc"), ("H1", "ex_h1"), ("Múltiplos H1", "ex_h1"),
                 ("H2", "ex_h2"), ("Conteúdo baixo", "ex_word_count"), ("Conteúdo: legibilidade", "ex_readability"),
                 ("Conteúdo duplicado (exato)", "ex_hash"), ("Segurança: formulário", "ex_forms"),
                 ("Resposta lenta", "ex_response_time"), ("Diretivas:", "ex_meta_robots")]
# Spider > Advanced > Ignore Non-Indexable URLs for Issues
NONIDX_PREFIXES = ("Title", "Meta description", "H1", "Múltiplos H1", "H2", "Conteúdo", "Imagens sem alt", "Dados estruturados",
                   "Sem dados estruturados", "Open Graph", "og:image", "Erros de ortografia", "Erros de gramática",
                   "Mobile", "Acessibilidade")

# SF 'Crawl Analysis': groups whose data is only calculated after the crawl (Configuration > Crawl Analysis)
ANALYSIS_GROUPS = ["link_score", "response_codes", "content", "canonicals", "pagination", "hreflang", "links",
                   "sitemaps", "analytics", "search_console"]
ISSUE_GROUPS = {
    "Cadeia de redirect (2+ saltos)": "response_codes", "Loop de redirect": "response_codes",
    "Redirect para erro": "response_codes",
    "Conteúdo quase duplicado": "content", "Conteúdo semanticamente similar": "content",
    "Conteúdo de baixa relevância": "content",
    "Canonical aponta para URL não indexável": "canonicals", "Canonical: URL sem link interno": "canonicals",
    "Paginação: destino não-200": "pagination", "Paginação: destino não indexável": "pagination",
    "Paginação: URL sem link <a>": "pagination", "Paginação: sequência quebrada": "pagination", "Paginação: loop": "pagination",
    "Hreflang: sem link de retorno": "hreflang", "Hreflang: destino não-200": "hreflang",
    "Hreflang: destino não canônico": "hreflang", "Hreflang: destino noindex": "hreflang",
    "Hreflang: URL sem link interno": "hreflang",
    "Links: inlinks internos follow e nofollow": "links", "Links: só inlinks internos nofollow": "links",
    "Links: só inlinks de páginas não indexáveis": "links",
    "Indexável fora da sitemap": "sitemaps", "Sitemaps: URL em várias sitemaps": "sitemaps",
    "Órfã (sitemap, GA4 ou Search Console)": "sitemaps",
}

INTERNAL_SEARCH_RE = re.compile(r"[?&](s|q|query|search|busca|buscar|k|keyword)=|/(search|busca|buscar|pesquisa)(/|$|\?)", re.I)
GA_PARAMS_RE = re.compile(r"[?&](utm_[a-z]+|_ga|_gl|gclid)=", re.I)


def _repetitive(path):
    parts = [x for x in path.lower().split("/") if x]
    return len(parts) != len(set(parts))


ISSUE_RULES = [
    # response codes
    ("Erro de cliente (4xx)", "Issue", "Alta", "page", lambda p: p["status"] and 400 <= p["status"] < 500),
    ("Erro de servidor (5xx)", "Issue", "Alta", "page", lambda p: p["status"] and p["status"] >= 500),
    ("Sem resposta", "Issue", "Alta", "page", lambda p: p["status"] == 0 and not is_blocked(p)),
    ("Bloqueado pelo robots.txt", "Warning", "Baixa", "page", is_blocked),
    ("Redirecionamento (3xx)", "Warning", "Baixa", "page", lambda p: p["status"] and 300 <= p["status"] < 400),
    ("Cadeia de redirect (2+ saltos)", "Warning", "Média", "page", lambda p: p["redirect_hops"] >= 2),
    ("Loop de redirect", "Issue", "Alta", "page", lambda p: p["redirect_loop"]),
    ("Redirect para erro", "Issue", "Alta", "page", lambda p: p["redirect_hops"] and (p["redirect_final_status"] or 0) >= 400),
    ("Contém links quebrados", "Issue", "Alta", "page", lambda p: p["broken_outlinks"] > 0),
    ("Links: página sem outlinks internos", "Warning", "Baixa", "html", lambda p: p["outlinks"] == 0),
    ("Links: outlinks internos com nofollow", "Warning", "Baixa", "html", lambda p: p["nofollow_outlinks"] > 0),
    ("Links: texto âncora não descritivo", "Opportunity", "Baixa", "html", lambda p: p["weak_anchors"] > 0),
    ("Links: sem inlinks no conteúdo", "Opportunity", "Baixa", "html", lambda p: p["unique_inlinks"] > 0 and p["content_inlinks"] == 0 and p["depth"] != 0),
    # URL
    ("URL com parâmetros", "Warning", "Baixa", "page", lambda p: "?" in p["url"]),
    ("URL com maiúsculas", "Warning", "Baixa", "page", lambda p: _path(p) != _path(p).lower()),
    ("URL com underscores", "Opportunity", "Baixa", "page", lambda p: "_" in _path(p)),
    ("URL com caracteres não-ASCII", "Warning", "Baixa", "page", lambda p: not p["url"].isascii() or "%" in _path(p)),
    ("URL com barras duplas", "Warning", "Baixa", "page", lambda p: "//" in _path(p)),
    ("URL acima de {url_max:g} caracteres", "Opportunity", "Baixa", "page", lambda p: p["url_len"] > PREFS["url_max"]),
    # titles / meta / headings
    ("Title ausente", "Issue", "Alta", "html", lambda p: not p["title"]),
    ("Title duplicado", "Issue", "Média", "html", lambda p: p.get("title_dup")),
    ("Title acima de {title_max:g} caracteres", "Opportunity", "Média", "html", lambda p: p["title_len"] > PREFS["title_max"]),
    ("Title acima de {title_px_max:g} pixels", "Opportunity", "Média", "html", lambda p: p["title_px"] > PREFS["title_px_max"]),
    ("Title abaixo de {title_min:g} caracteres", "Opportunity", "Baixa", "html", lambda p: 0 < p["title_len"] < PREFS["title_min"]),
    ("Meta description ausente", "Issue", "Média", "html", lambda p: not p["meta_desc"]),
    ("Meta description duplicada", "Issue", "Média", "html", lambda p: p.get("meta_desc_dup")),
    ("Meta description acima de {md_max:g} caracteres", "Opportunity", "Baixa", "html", lambda p: p["md_len"] > PREFS["md_max"]),
    ("Meta description acima de {md_px_max:g} pixels", "Opportunity", "Baixa", "html", lambda p: p["md_px"] > PREFS["md_px_max"]),
    ("Meta description abaixo de {md_min:g} caracteres", "Opportunity", "Baixa", "html", lambda p: 0 < p["md_len"] < PREFS["md_min"]),
    ("H1 ausente", "Issue", "Média", "html", lambda p: p["h1_count"] == 0),
    ("H1 duplicado", "Warning", "Baixa", "html", lambda p: p.get("h1_1_dup")),
    ("Múltiplos H1", "Warning", "Baixa", "html", lambda p: p["h1_count"] > 1),
    ("H2 ausente", "Warning", "Baixa", "html", lambda p: p["h2_count"] == 0),
    # content
    ("Conteúdo baixo (< {low_words:g} palavras)", "Opportunity", "Média", "html", lambda p: (p["word_count"] or 0) < PREFS["low_words"]),
    ("Conteúdo duplicado (exato)", "Issue", "Média", "html", lambda p: p.get("content_hash_dup")),
    ("Conteúdo quase duplicado", "Warning", "Média", "html", lambda p: (p["near_dup_count"] or 0) > 0),
    ("Conteúdo semanticamente similar", "Warning", "Média", "html", lambda p: (p["semantic_similar"] or 0) > 0),
    ("Conteúdo de baixa relevância", "Opportunity", "Baixa", "html", lambda p: p["low_relevance"]),
    ("Erros de ortografia", "Warning", "Baixa", "html", lambda p: (p["spelling_errors"] or 0) > 0),
    ("Erros de gramática", "Warning", "Baixa", "html", lambda p: (p["grammar_errors"] or 0) > 0),
    ("Página truncada (acima do limite de tamanho)", "Warning", "Baixa", "page", lambda p: p["truncated"]),
    ("Erro na renderização JavaScript", "Warning", "Média", "page", lambda p: p["render_error"]),
    # images
    ("Imagens sem alt", "Issue", "Média", "html", lambda p: p["images_missing_alt"] > 0),
    ("Imagem quebrada", "Issue", "Alta", "image", is_broken),
    ("Imagem acima de {img_kb:g} KB", "Opportunity", "Média", "image", lambda i: (i["size"] or 0) > PREFS["img_kb"] * 1024),
    # canonicals / directives / pagination
    ("Canonical ausente", "Warning", "Baixa", "html", lambda p: not p["canonical"]),
    ("Canonicalizada", "Warning", "Média", "html", lambda p: p["canonical"] and p["canonical"] != p["url"]),
    ("Canonical: múltiplos", "Issue", "Alta", "html", lambda p: p["canonical_count"] > 1),
    ("Canonical: URL relativa", "Warning", "Baixa", "html", lambda p: p["canonical_relative"]),
    ("Canonical fora do <head>", "Issue", "Alta", "html", lambda p: p["canonical_outside_head"]),
    ("Canonical contém fragmento (#)", "Warning", "Baixa", "html", lambda p: p["canonical_fragment"]),
    ("Canonical aponta para URL não indexável", "Issue", "Alta", "html", lambda p: p["canonical_nonindexable"]),
    ("Canonical: URL sem link interno", "Warning", "Baixa", "html", lambda p: p.get("canonical_unlinked")),
    ("Canonical: HTML e cabeçalho HTTP diferentes", "Issue", "Média", "html", lambda p: p["canonical_mismatch"]),
    ("Paginação: destino não-200", "Issue", "Média", "html", lambda p: p["pag_non200"]),
    ("Paginação: destino não indexável", "Warning", "Média", "html", lambda p: p["pag_nonindexable"]),
    ("Paginação: URL sem link <a>", "Warning", "Baixa", "html", lambda p: p["pag_unlinked"]),
    ("Paginação: sequência quebrada", "Warning", "Baixa", "html", lambda p: p["pag_sequence_error"]),
    ("Paginação: loop", "Issue", "Média", "html", lambda p: p["pag_loop"]),
    ("Paginação: múltiplos rel next/prev", "Warning", "Baixa", "html", lambda p: p["pag_multiple"]),
    ("JavaScript: conteúdo depende do JS (20%+ das palavras)", "Warning", "Média", "html", lambda p: (p["js_word_diff_pct"] or 0) >= 20),
    ("JavaScript: links só no HTML renderizado", "Warning", "Média", "html", lambda p: (p["js_links_only_rendered"] or 0) > 0),
    ("JavaScript: title alterado", "Warning", "Média", "html", lambda p: p["js_title_changed"]),
    ("JavaScript: meta description alterada", "Warning", "Baixa", "html", lambda p: p["js_meta_changed"]),
    ("JavaScript: H1 alterado", "Warning", "Baixa", "html", lambda p: p["js_h1_changed"]),
    ("JavaScript: canonical alterado", "Issue", "Alta", "html", lambda p: p["js_canonical_changed"]),
    ("JavaScript: noindex só no HTML renderizado", "Issue", "Alta", "html", lambda p: p["js_noindex_only_rendered"]),
    ("Noindex", "Warning", "Alta", "page", lambda p: "noindex" in (p["meta_robots"] + " " + p["x_robots"]).lower()),
    # hreflang
    ("Hreflang: código de idioma inválido", "Issue", "Média", "html", lambda p: "código inválido" in p["hreflang_issues"]),
    ("Hreflang: sem autorreferência", "Warning", "Baixa", "html", lambda p: "sem autorreferência" in p["hreflang_issues"]),
    ("Hreflang: sem link de retorno", "Issue", "Média", "html", lambda p: "sem retorno" in p["hreflang_issues"]),
    ("Hreflang: destino não-200", "Issue", "Média", "html", lambda p: "destino não-200" in p["hreflang_issues"]),
    # structured data / social
    ("Dados estruturados: erros de validação", "Issue", "Alta", "html", lambda p: p["sd_errors"] > 0),
    ("Dados estruturados: avisos de validação", "Warning", "Baixa", "html", lambda p: bool(p["sd_warnings"])),
    ("Sem dados estruturados", "Opportunity", "Baixa", "html", lambda p: not p["sd_types"]),
    ("Open Graph ausente", "Opportunity", "Baixa", "html", lambda p: not p["og_title"]),
    ("og:image ausente", "Opportunity", "Baixa", "html", lambda p: not p["og_image"]),
    # sitemaps
    ("Órfã (sitemap, GA4 ou Search Console)", "Warning", "Média", "page", lambda p: p["orphan"]),
    ("Não indexável na sitemap", "Issue", "Média", "page", lambda p: p["in_sitemap"] and p["indexability"] == "Non-Indexable"),
    ("Indexável fora da sitemap", "Warning", "Baixa", "html", lambda p: p["not_in_sitemap"]),
    # security
    ("URL HTTP insegura", "Issue", "Alta", "html", lambda p: p["url"].startswith("http:")),
    ("Conteúdo misto (HTTP em página HTTPS)", "Issue", "Alta", "html", lambda p: p["mixed_content"] > 0),
    ("Cabeçalho HSTS ausente", "Warning", "Baixa", "html", lambda p: "HSTS" in p["sec_missing"]),
    ("X-Content-Type-Options ausente", "Warning", "Baixa", "html", lambda p: "X-Content-Type-Options" in p["sec_missing"]),
    ("X-Frame-Options ausente", "Warning", "Baixa", "html", lambda p: "X-Frame-Options" in p["sec_missing"]),
    ("Content-Security-Policy ausente", "Warning", "Baixa", "html", lambda p: "Content-Security-Policy" in p["sec_missing"]),
    ("Referrer-Policy ausente", "Warning", "Baixa", "html", lambda p: "Referrer-Policy" in p["sec_missing"]),
    ("Links HTTP internos para host com HSTS", "Warning", "Baixa", "html", lambda p: p["hsts_http_links"] > 0),
    ("PDF sem título", "Opportunity", "Baixa", "page", lambda p: p["content_type"] == "application/pdf" and p["status"] == 200 and not p["title"]),
    # performance
    ("Validação: elementos inválidos no <head>", "Issue", "Alta", "html", lambda p: bool(p["val_invalid_head"])),
    ("Validação: <head> ausente", "Issue", "Alta", "html", lambda p: p["val_missing_head"]),
    ("Validação: múltiplos <head>", "Issue", "Alta", "html", lambda p: p["val_multiple_head"]),
    ("Validação: <body> ausente", "Issue", "Alta", "html", lambda p: p["val_missing_body"]),
    ("Validação: múltiplos <body>", "Issue", "Alta", "html", lambda p: p["val_multiple_body"]),
    ("Validação: <body> antes de <html>", "Issue", "Alta", "html", lambda p: p["val_body_before_html"]),
    ("Validação: <head> não é o primeiro em <html>", "Warning", "Média", "html", lambda p: p["val_head_not_first"]),
    ("Validação: documento HTML acima de 2 MB", "Warning", "Média", "html", lambda p: p["val_over_2mb"]),
    ("Validação: recurso acima de 2 MB", "Warning", "Baixa", "page",
     lambda p: p["status"] == 200 and p["content_type"] not in ("text/html", "") and (p["size"] or 0) > 2 * 1024 * 1024),
    ("Segurança: formulário em URL HTTP", "Issue", "Alta", "html", lambda p: p.get("form_on_http")),
    ("Segurança: formulário com ação HTTP insegura", "Issue", "Alta", "html", lambda p: p.get("form_insecure")),
    ("Segurança: links cross-origin inseguros", "Warning", "Baixa", "html", lambda p: (p.get("unsafe_cross_origin") or 0) > 0),
    ("Segurança: links de recursos com protocolo relativo", "Warning", "Baixa", "html", lambda p: (p.get("protocol_relative") or 0) > 0),
    ("Códigos de resposta: recurso bloqueado pelo robots.txt", "Warning", "Média", "page", lambda p: p.get("blocked_resource")),
    ("Códigos de resposta: redirecionamento por JavaScript", "Warning", "Média", "page", lambda p: p.get("js_redirect")),
    ("Códigos de resposta: redirecionamento por meta refresh", "Warning", "Média", "page",
     lambda p: p.get("meta_refresh_url") and p["meta_refresh_url"] != p["url"]),
    ("URL: contém espaço", "Issue", "Média", "page", lambda p: " " in p["url"] or "%20" in p["url"]),
    ("URL: caminho repetitivo", "Opportunity", "Baixa", "page", lambda p: _repetitive(_path(p))),
    ("URL: busca interna", "Warning", "Média", "page", lambda p: bool(INTERNAL_SEARCH_RE.search(p["url"]))),
    ("URL: parâmetros de rastreamento do GA", "Warning", "Baixa", "page", lambda p: bool(GA_PARAMS_RE.search(p["url"]))),
    ("URL: âncora (#) quebrada", "Warning", "Baixa", "html", lambda p: (p.get("broken_bookmarks") or 0) > 0),
    ("Title: múltiplos", "Issue", "Média", "html", lambda p: (p.get("title_count") or 0) > 1),
    ("Title: fora do <head>", "Issue", "Alta", "html", lambda p: p.get("title_outside_head")),
    ("Title abaixo de {title_px_min:g} pixels", "Opportunity", "Baixa", "html", lambda p: 0 < p["title_px"] < PREFS["title_px_min"]),
    ("Meta description: múltiplas", "Issue", "Média", "html", lambda p: (p.get("md_count") or 0) > 1),
    ("Meta description: fora do <head>", "Issue", "Alta", "html", lambda p: p.get("md_outside_head")),
    ("Meta description abaixo de {md_px_min:g} pixels", "Opportunity", "Baixa", "html", lambda p: 0 < p["md_px"] < PREFS["md_px_min"]),
    ("H1: texto alt de imagem", "Warning", "Baixa", "html", lambda p: p.get("h1_img_alt")),
    ("H1: não sequencial", "Warning", "Baixa", "html", lambda p: p.get("h1_nonseq")),
    ("H2: não sequencial", "Warning", "Baixa", "html", lambda p: p.get("h2_nonseq")),
    ("H2: duplicado", "Opportunity", "Baixa", "html", lambda p: p.get("h2_1_dup")),
    ("H2: acima de {h2_max:g} caracteres", "Opportunity", "Baixa", "html", lambda p: (p.get("h2_len") or 0) > PREFS["h2_max"]),
    ("H1: acima de {h1_max:g} caracteres", "Opportunity", "Baixa", "html", lambda p: (p.get("h1_len") or 0) > PREFS["h1_max"]),
    ("Conteúdo: soft 404", "Issue", "Alta", "html", lambda p: p.get("soft_404")),
    ("Conteúdo: lorem ipsum", "Warning", "Média", "html", lambda p: p.get("lorem_ipsum")),
    ("Conteúdo: legibilidade difícil", "Opportunity", "Baixa", "html", lambda p: p.get("flesch") is not None and 30 <= p["flesch"] < 50),
    ("Conteúdo: legibilidade muito difícil", "Opportunity", "Baixa", "html", lambda p: p.get("flesch") is not None and p["flesch"] < 30),
    ("Imagem: sem atributo alt", "Issue", "Média", "image", lambda i: (i.get("missing_alt_attr") or 0) > 0),
    ("Imagem: texto alt acima de {alt_max:g} caracteres", "Opportunity", "Baixa", "image", lambda i: (i.get("alt_long") or 0) > 0),
    ("Imagem: sem atributos de tamanho (width/height)", "Opportunity", "Baixa", "image", lambda i: (i.get("missing_size") or 0) > 0),
    ("Diretivas: fora do <head>", "Issue", "Alta", "html", lambda p: p.get("robots_outside_head")),
    ("Hreflang: sem x-default", "Warning", "Baixa", "html", lambda p: "sem x-default" in p["hreflang_issues"]),
    ("Hreflang: entradas múltiplas", "Issue", "Média", "html", lambda p: "entradas múltiplas" in p["hreflang_issues"]),
    ("Hreflang: destino não canônico", "Issue", "Média", "html", lambda p: "destino não canônico" in p["hreflang_issues"]),
    ("Hreflang: destino noindex", "Issue", "Média", "html", lambda p: "destino noindex" in p["hreflang_issues"]),
    ("Hreflang: URL sem link interno", "Opportunity", "Baixa", "html", lambda p: "URL sem link interno" in p["hreflang_issues"]),
    ("Hreflang: fora do <head>", "Issue", "Alta", "html", lambda p: p.get("hreflang_outside_head")),
    ("JavaScript: erros no console", "Warning", "Média", "html", lambda p: (p.get("js_errors") or 0) > 0),
    ("JavaScript: página com recursos bloqueados", "Warning", "Média", "html", lambda p: (p.get("blocked_resources") or 0) > 0),
    ("Links: outlinks internos sem texto âncora", "Opportunity", "Baixa", "html", lambda p: (p.get("noanchor_outlinks") or 0) > 0),
    ("Links: profundidade alta (> {deep:g} cliques)", "Opportunity", "Baixa", "html", lambda p: (p["depth"] or 0) > PREFS["deep"]),
    ("Links: muitos outlinks internos (> {int_outlinks:g})", "Warning", "Baixa", "html", lambda p: p["outlinks"] > PREFS["int_outlinks"]),
    ("Links: muitos outlinks externos (> {ext_outlinks:g})", "Warning", "Baixa", "html", lambda p: p["external_outlinks"] > PREFS["ext_outlinks"]),
    ("Links: inlinks internos follow e nofollow", "Warning", "Baixa", "html", lambda p: p.get("mixed_inlinks")),
    ("Links: só inlinks internos nofollow", "Warning", "Média", "html", lambda p: p.get("nofollow_only_inlinks")),
    ("Links: só inlinks de páginas não indexáveis", "Warning", "Média", "html", lambda p: p.get("nonidx_inlinks_only")),
    ("Links: páginas com outlinks internos não rastreáveis", "Warning", "Média", "html", lambda p: (p.get("uncrawlable_outlinks") or 0) > 0),
    ("Dados estruturados: erro de parse", "Issue", "Alta", "html", lambda p: p.get("sd_parse_error")),
    ("Sitemaps: URL em várias sitemaps", "Warning", "Baixa", "page", lambda p: p.get("sitemap_multi")),
    ("Analytics: não indexável com sessões", "Warning", "Média", "html",
     lambda p: (p.get("ga_sessions") or 0) > 0 and p["indexability"] == "Non-Indexable"),
    ("Acessibilidade: violações críticas", "Issue", "Alta", "html", lambda p: (p.get("a11y_critical") or 0) > 0),
    ("Acessibilidade: violações graves", "Issue", "Média", "html", lambda p: (p.get("a11y_serious") or 0) > 0),
    ("Acessibilidade: violações moderadas", "Warning", "Média", "html", lambda p: (p.get("a11y_moderate") or 0) > 0),
    ("Acessibilidade: violações menores", "Opportunity", "Baixa", "html", lambda p: (p.get("a11y_minor") or 0) > 0),
    ("Mobile: viewport ausente", "Issue", "Alta", "html", lambda p: not p.get("viewport") and not p.get("pdf_pages")),
    ("Mobile: viewport sem width=device-width", "Warning", "Média", "html", lambda p: p.get("mob_no_device_width")),
    ("Mobile: zoom desativado", "Warning", "Média", "html", lambda p: p.get("mob_zoom_disabled")),
    ("Mobile: plugins não suportados", "Issue", "Média", "html", lambda p: (p.get("mob_plugins") or 0) > 0),
    ("AMP: erros de validação", "Issue", "Alta", "html", lambda p: bool(p.get("amp_errors"))),
    ("AMP: URL AMP não-200", "Issue", "Alta", "html", lambda p: p.get("amp_non200")),
    ("AMP: página canônica sem link amphtml de volta", "Warning", "Média", "html", lambda p: p.get("amp_no_return")),
    ("Resposta lenta (> {slow_s:g}s)", "Opportunity", "Média", "page", lambda p: (p["response_ms"] or 0) > PREFS["slow_s"] * 1000),
    ("PageSpeed ruim (< 50)", "Issue", "Média", "html", lambda p: p["psi_score"] is not None and p["psi_score"] < 50),
    ("Core Web Vitals: reprovado", "Issue", "Média", "html", lambda p: p.get("psi_cwv") == "Reprovado"),
    # external
    ("Link externo quebrado", "Issue", "Alta", "external", is_broken),
]
