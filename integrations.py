"""Third-party API integrations (Google Analytics 4, Search Console, PageSpeed Insights,
Majestic, Ahrefs, Moz and AI providers). Config (including API keys) is stored locally in
data/integrations.json, which is git-ignored and never served."""
import asyncio
import base64
import json
import re
import time
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import quote, urlparse

import httpx

GA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly"
GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
PSI_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
DEFAULT_PROMPT = ("Resuma em uma frase o assunto principal desta página.\n\n"
                  "URL: {url}\nTítulo: {title}\nMeta description: {meta}\nH1: {h1}\n\n{text}")

_GOOGLE_AUTH = [
    {"name": "auth", "label": "Autenticação", "type": "select", "default": "service",
     "options": [["service", "Conta de serviço (JSON)"], ["oauth", "Login Google (OAuth)"]]},
    {"name": "service_json", "label": "JSON da conta de serviço", "type": "textarea", "secret": True, "show_if": "auth=service", "link": {"url": "https://console.cloud.google.com/iam-admin/serviceaccounts", "label": "Criar conta de serviço no Google Cloud"}},
    {"name": "client_id", "label": "OAuth Client ID", "type": "text", "show_if": "auth=oauth", "link": {"url": "https://console.cloud.google.com/apis/credentials", "label": "Criar ID do cliente OAuth no Google Cloud"}},
    {"name": "client_secret", "label": "OAuth Client Secret", "type": "password", "secret": True, "show_if": "auth=oauth"},
]
_AI_FIELDS = [
    {"name": "prompts", "label": "Prompts", "type": "prompts", "default": []},
    {"name": "max_chars", "label": "Máx. caracteres do texto da página enviados", "type": "number", "default": 4000},
    {"name": "limit", "label": "Máx. de páginas por solicitação", "type": "number", "default": 100},
    {"name": "rpm", "label": "Requisições por minuto (0 = sem limite)", "type": "number", "default": 60},
]

PROVIDERS = [
    {"id": "ga4", "name": "Google Analytics 4", "icon": "GA4", "color": "#f9ab00", "google": GA_SCOPE, "options": "Carregar propriedades",
     "help": "Conta de serviço: crie uma no Google Cloud, ative a 'Google Analytics Data API' e adicione o e-mail da conta como Leitor na propriedade GA4. "
             "OAuth: crie um ID do cliente OAuth do tipo 'App para computador' e clique em 'Entrar com Google'.",
     "fields": _GOOGLE_AUTH + [
         {"name": "property", "label": "ID da propriedade GA4", "type": "text", "options": True},
         {"name": "days", "label": "Período (dias)", "type": "number", "default": 30}]},
    {"id": "gsc", "name": "Google Search Console", "icon": "GSC", "color": "#4285f4", "google": GSC_SCOPE, "options": "Carregar propriedades",
     "help": "Conta de serviço: ative a 'Google Search Console API' e adicione o e-mail da conta como usuário da propriedade. "
             "OAuth: crie um ID do cliente OAuth do tipo 'App para computador' e clique em 'Entrar com Google'.",
     "fields": _GOOGLE_AUTH + [
         {"name": "site_url", "label": "Propriedade (ex.: sc-domain:exemplo.com ou https://exemplo.com/)", "type": "text", "options": True},
         {"name": "days", "label": "Período (dias)", "type": "number", "default": 28}]},
    {"id": "psi", "name": "PageSpeed Insights", "icon": "PSI", "color": "#34a853",
     "help": "Chave gratuita em console.cloud.google.com (API 'PageSpeed Insights'). Sem chave, usa a cota compartilhada, que costuma estar esgotada.",
     "fields": [{"name": "key", "label": "Chave de API", "type": "password", "secret": True, "link": {"url": "https://developers.google.com/speed/docs/insights/v5/get-started", "label": "Obter chave do PageSpeed Insights"}},
                {"name": "strategy", "label": "Dispositivo", "type": "select", "default": "mobile", "options": [["mobile", "Mobile"], ["desktop", "Desktop"]]},
                {"name": "limit", "label": "Máx. de páginas por solicitação", "type": "number", "default": 100}]},
    {"id": "majestic", "name": "Majestic", "icon": "MJ", "color": "#c0392b",
     "help": "Requer um plano Majestic com acesso à API (chave em majestic.com > Account > API).",
     "fields": [{"name": "api_key", "label": "Chave de API", "type": "password", "secret": True, "link": {"url": "https://majestic.com/account/api", "label": "Obter chave da API Majestic"}},
                {"name": "datasource", "label": "Índice", "type": "select", "default": "fresh", "options": [["fresh", "Fresh"], ["historic", "Historic"]]}]},
    {"id": "ahrefs", "name": "Ahrefs", "icon": "ah", "color": "#054ada",
     "help": "Requer um plano Ahrefs com acesso à API v3 (token em app.ahrefs.com > API keys).",
     "fields": [{"name": "api_key", "label": "Token da API v3", "type": "password", "secret": True, "link": {"url": "https://docs.ahrefs.com/", "label": "Como criar o token (documentação Ahrefs)"}},
                {"name": "limit", "label": "Máx. de páginas por solicitação", "type": "number", "default": 100}]},
    {"id": "moz", "name": "Moz", "icon": "MOZ", "color": "#1fa2d4",
     "help": "Use Access ID + Secret Key (Links API) ou um token da nova API Moz.",
     "fields": [{"name": "access_id", "label": "Access ID", "type": "text", "link": {"url": "https://moz.com/api", "label": "Página da API Moz (credenciais)"}},
                {"name": "secret_key", "label": "Secret Key", "type": "password", "secret": True},
                {"name": "token", "label": "Token (alternativa)", "type": "password", "secret": True}]},
    {"id": "openai", "name": "OpenAI", "icon": "AI", "color": "#111111", "ai": True,
     "help": "Executa o prompt em cada página e grava a resposta na aba IA.",
     "fields": [{"name": "api_key", "label": "Chave de API", "type": "password", "secret": True, "link": {"url": "https://platform.openai.com/api-keys", "label": "Obter chave de API da OpenAI"}},
                {"name": "model", "label": "Modelo", "type": "text", "default": "gpt-4o-mini"},
                {"name": "base_url", "label": "Endpoint (compatível com OpenAI: LM Studio, OpenRouter, Azure…)", "type": "text",
                 "default": "https://api.openai.com/v1"}] + _AI_FIELDS},
    {"id": "gemini", "name": "Gemini", "icon": "G✦", "color": "#5b6cf0", "ai": True,
     "help": "Chave em aistudio.google.com. Executa o prompt em cada página e grava a resposta na aba IA.",
     "fields": [{"name": "api_key", "label": "Chave de API", "type": "password", "secret": True, "link": {"url": "https://aistudio.google.com/app/apikey", "label": "Obter chave de API do Gemini (Google AI Studio)"}},
                {"name": "model", "label": "Modelo", "type": "text", "default": "gemini-2.0-flash"}] + _AI_FIELDS},
    {"id": "ollama", "name": "Ollama", "icon": "OL", "color": "#333333", "ai": True,
     "help": "Modelo local: instale o Ollama e baixe um modelo (ex.: ollama pull llama3.2). Nada sai do seu computador.",
     "fields": [{"name": "base_url", "label": "Endereço do Ollama", "type": "text", "default": "http://localhost:11434", "link": {"url": "https://ollama.com/download", "label": "Baixar o Ollama (não precisa de chave)"}},
                {"name": "model", "label": "Modelo", "type": "text", "default": "llama3.2"}] + _AI_FIELDS},
    {"id": "anthropic", "name": "Anthropic", "icon": "A\\", "color": "#191919", "ai": True,
     "help": "Chave em console.anthropic.com. Executa o prompt em cada página e grava a resposta na aba IA.",
     "fields": [{"name": "api_key", "label": "Chave de API", "type": "password", "secret": True, "link": {"url": "https://console.anthropic.com/settings/keys", "label": "Obter chave de API da Anthropic"}},
                {"name": "model", "label": "Modelo", "type": "text", "default": "claude-opus-5-5"}] + _AI_FIELDS},
]
BY_ID = {p["id"]: p for p in PROVIDERS}
# fields each integration writes into page records (also used for exports)
PAGE_FIELDS = [
    "ga_sessions", "ga_users", "ga_views", "ga_engagement_rate", "ga_bounce_rate", "ga_avg_session_duration", "ga_key_events",
    "gsc_clicks", "gsc_impressions", "gsc_ctr", "gsc_position",
    "mj_trust_flow", "mj_citation_flow", "mj_ext_backlinks", "mj_ref_domains",
    "ah_backlinks", "ah_refdomains", "ah_org_traffic", "ah_org_keywords",
    "moz_pa", "moz_da", "moz_spam_score", "moz_ext_pages", "moz_root_domains",
]
# Claude models that accept the server-side refusal fallback ("default" form) and output_config.effort
_CLAUDE_FALLBACK = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}
_CLAUDE_EFFORT = _CLAUDE_FALLBACK | {"claude-haiku-5-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"}


def url_key(url):
    p = urlparse(url)
    host = (p.hostname or "").lower()
    host = host[4:] if host.startswith("www.") else host
    return host + (p.path or "/")


def _num(v):
    try:
        return round(float(v), 4)
    except (TypeError, ValueError):
        return None


class IntegrationError(Exception):
    pass


class Integrations:
    def __init__(self, data_dir: Path):
        self.path = data_dir / "integrations.json"
        data_dir.mkdir(exist_ok=True)
        try:
            self.cfg = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.cfg = {}
        self.state = {p["id"]: dict(running=False, done=0, total=0, errors=0, message="", last_error="")
                      for p in PROVIDERS}
        self._next_call, self._locks = {}, {}
        self._segments = {}

    # ---------- config ----------
    def _save(self):
        self.path.write_text(json.dumps(self.cfg, indent=2, ensure_ascii=False), encoding="utf-8")

    def conf(self, pid):
        c = {f["name"]: f.get("default", "") for f in BY_ID[pid]["fields"]}
        c.update(self.cfg.get(pid, {}))
        return c

    def connected(self, pid):
        return bool(self.cfg.get(pid, {}).get("_connected"))

    def public(self):
        out = []
        for p in PROVIDERS:
            c = self.conf(p["id"])
            values = {}
            for f in p["fields"]:
                v = c.get(f["name"], "")
                values[f["name"]] = "" if f.get("secret") else v
                if f.get("secret"):
                    values["_has_" + f["name"]] = bool(v)
            out.append(dict({k: v for k, v in p.items() if k != "google"}, values=values,
                            google=bool(p.get("google")), oauth_ok=bool(c.get("refresh_token")),
                            connected=self.connected(p["id"]), state=self.state[p["id"]]))
        return out

    def states(self):
        return {pid: dict(st, connected=self.connected(pid)) for pid, st in self.state.items()}

    def update(self, pid, values):
        cur = self.cfg.setdefault(pid, {})
        for f in BY_ID[pid]["fields"]:
            if f["name"] in values:
                v = values[f["name"]]
                if f.get("secret") and v == "":
                    continue  # empty secret field keeps the stored value
                if f["type"] == "prompts" and isinstance(v, str):
                    try:
                        v = json.loads(v or "[]")
                    except ValueError:
                        raise IntegrationError("Lista de prompts inválida")
                cur[f["name"]] = v
        cur["_connected"] = False
        self._save()

    def disconnect(self, pid):
        self.cfg.pop(pid, None)
        self.state[pid].update(message="", last_error="", done=0, total=0, errors=0)
        self._save()

    # ---------- Google auth ----------
    def _google_token_sync(self, pid):
        import google.auth.transport.requests as gtr
        c = self.conf(pid)
        scope = BY_ID[pid]["google"]
        if c.get("auth") == "oauth":
            if not c.get("refresh_token"):
                raise IntegrationError("Faça login com 'Entrar com Google' primeiro")
            from google.oauth2.credentials import Credentials
            creds = Credentials(None, refresh_token=c["refresh_token"], client_id=c.get("client_id"),
                                client_secret=c.get("client_secret"), token_uri="https://oauth2.googleapis.com/token",
                                scopes=[scope])
        else:
            if not c.get("service_json"):
                raise IntegrationError("Cole o JSON da conta de serviço")
            from google.oauth2 import service_account
            try:
                info = json.loads(c["service_json"])
            except ValueError:
                raise IntegrationError("JSON da conta de serviço inválido")
            creds = service_account.Credentials.from_service_account_info(info, scopes=[scope])
        creds.refresh(gtr.Request())
        return creds.token

    async def google_token(self, pid):
        try:
            return await asyncio.to_thread(self._google_token_sync, pid)
        except IntegrationError:
            raise
        except Exception as e:
            raise IntegrationError(f"Falha na autenticação Google: {e}")

    def oauth_login_sync(self, pid):
        """Opens the browser for Google sign-in (local app) and stores the refresh token."""
        from google_auth_oauthlib.flow import InstalledAppFlow
        c = self.conf(pid)
        if not c.get("client_id") or not c.get("client_secret"):
            raise IntegrationError("Preencha o OAuth Client ID e o Client Secret")
        flow = InstalledAppFlow.from_client_config(
            {"installed": {"client_id": c["client_id"], "client_secret": c["client_secret"],
                           "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                           "token_uri": "https://oauth2.googleapis.com/token",
                           "redirect_uris": ["http://localhost"]}},
            scopes=[BY_ID[pid]["google"]])
        creds = flow.run_local_server(port=0, open_browser=True, timeout_seconds=300,
                                      authorization_prompt_message="", success_message="Login concluído. Pode fechar esta aba.")
        if not creds.refresh_token:
            raise IntegrationError("O Google não devolveu um refresh token; tente novamente")
        self.cfg.setdefault(pid, {})["refresh_token"] = creds.refresh_token
        self._save()

    async def _gget(self, client, pid, url, **kw):
        token = await self.google_token(pid)
        r = await client.request(kw.pop("method", "GET"), url, headers={"Authorization": f"Bearer {token}"}, **kw)
        if r.status_code >= 400:
            try:
                msg = r.json().get("error", {}).get("message", r.text[:200])
            except ValueError:
                msg = r.text[:200]
            raise IntegrationError(f"HTTP {r.status_code}: {msg}")
        return r.json()

    async def options(self, pid):
        async with httpx.AsyncClient(timeout=60) as client:
            if pid == "ga4":
                data = await self._gget(client, pid, "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200")
                return [[ps["property"].split("/")[-1], f'{ps.get("displayName", "")} — {a.get("displayName", "")} ({ps["property"].split("/")[-1]})']
                        for a in data.get("accountSummaries", []) for ps in a.get("propertySummaries", [])]
            if pid == "gsc":
                data = await self._gget(client, pid, "https://www.googleapis.com/webmasters/v3/sites")
                return [[s["siteUrl"], f'{s["siteUrl"]} ({s.get("permissionLevel", "")})'] for s in data.get("siteEntry", [])]
        return []

    # ---------- connect (validate credentials) ----------
    async def connect(self, pid, start_url=""):
        c = self.conf(pid)
        async with httpx.AsyncClient(timeout=90) as client:
            if pid == "ga4":
                if not c.get("property"):
                    raise IntegrationError("Informe o ID da propriedade GA4 (ou use 'Carregar propriedades')")
                await self._gget(client, pid, f'https://analyticsdata.googleapis.com/v1beta/properties/{c["property"]}:runReport',
                                 method="POST", json={"dateRanges": [{"startDate": "7daysAgo", "endDate": "today"}],
                                                      "metrics": [{"name": "sessions"}], "limit": 1})
            elif pid == "gsc":
                if not c.get("site_url"):
                    raise IntegrationError("Informe a propriedade do Search Console (ou use 'Carregar propriedades')")
                await self._gget(client, pid, "https://www.googleapis.com/webmasters/v3/sites/" + quote(c["site_url"], safe=""))
            elif pid == "psi":
                if c.get("key"):
                    r = await client.get(PSI_URL, params={"url": "https://www.google.com/", "category": "performance", "key": c["key"]}, timeout=120)
                    if r.status_code != 200:
                        raise IntegrationError(r.json().get("error", {}).get("message", f"HTTP {r.status_code}"))
            elif pid == "majestic":
                r = await client.get("https://api.majestic.com/api/json", params={"app_api_key": c.get("api_key", ""), "cmd": "GetSubscriptionInfo"})
                j = r.json()
                if j.get("Code") != "OK":
                    raise IntegrationError(j.get("ErrorMessage") or j.get("Code") or f"HTTP {r.status_code}")
            elif pid == "ahrefs":
                r = await client.get("https://api.ahrefs.com/v3/subscription-info/limits-and-usage",
                                     headers={"Authorization": f'Bearer {c.get("api_key", "")}'})
                if r.status_code != 200:
                    raise IntegrationError(f"HTTP {r.status_code}: {r.text[:200]}")
            elif pid == "moz":
                await self._moz(client, c, ["moz.com"])
            elif pid == "openai":
                r = await client.get(c["base_url"].rstrip("/") + "/models", headers={"Authorization": f'Bearer {c.get("api_key", "")}'})
                if r.status_code != 200:
                    raise IntegrationError(f"HTTP {r.status_code}: {r.text[:200]}")
            elif pid == "gemini":
                r = await client.get("https://generativelanguage.googleapis.com/v1beta/models", headers={"x-goog-api-key": c.get("api_key", "")})
                if r.status_code != 200:
                    raise IntegrationError(f"HTTP {r.status_code}: {r.text[:200]}")
            elif pid == "ollama":
                try:
                    r = await client.get(c["base_url"].rstrip("/") + "/api/tags")
                except httpx.HTTPError as e:
                    raise IntegrationError(f"Ollama não respondeu em {c['base_url']}: {e}")
                names = [m.get("name", "") for m in r.json().get("models", [])]
                if c.get("model") and not any(n == c["model"] or n.split(":")[0] == c["model"] for n in names):
                    raise IntegrationError(f"Modelo '{c['model']}' não encontrado no Ollama. Disponíveis: {', '.join(names) or 'nenhum'}")
            elif pid == "anthropic":
                import anthropic
                try:
                    await anthropic.AsyncAnthropic(api_key=c.get("api_key", ""), max_retries=1).models.list(limit=1)
                except anthropic.AuthenticationError:
                    raise IntegrationError("Chave de API da Anthropic inválida")
                except anthropic.APIError as e:
                    raise IntegrationError(f"Anthropic: {e}")
        self.cfg.setdefault(pid, {})["_connected"] = True
        self._save()

    # ---------- fetching ----------
    def _begin(self, pid, total):
        self.state[pid].update(running=True, done=0, total=total, errors=0, message="", last_error="")

    def _fail(self, pid, err):
        st = self.state[pid]
        st["errors"] += 1
        st["last_error"] = str(err)[:300]

    async def run(self, crawler, ids=None, segments=None):
        ids = [p["id"] for p in PROVIDERS if self.connected(p["id"]) and (not ids or p["id"] in ids)]
        self._segments = {}
        for sg in segments or []:
            try:
                self._segments[sg["name"]] = re.compile(sg["regex"], re.I)
            except (KeyError, re.error):
                pass
        await asyncio.gather(*(self._run_one(pid, crawler) for pid in ids))

    def prompts(self, pid):
        c = self.conf(pid)
        prompts = c.get("prompts") or []
        if isinstance(prompts, str):
            try:
                prompts = json.loads(prompts)
            except ValueError:
                prompts = []
        if not prompts and c.get("prompt"):  # configs saved before multi-prompt support
            prompts = [{"name": "Prompt 1", "type": "chat", "content": "page_text", "prompt": c["prompt"]}]
        return [p for p in prompts if isinstance(p, dict)][:100]

    async def _run_one(self, pid, crawler):
        from analysis import is_html
        pages = [p for p in list(crawler.pages.values()) if is_html(p)]
        indexable = [p for p in pages if p["indexability"] == "Indexable"]
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                if pid == "ga4":
                    await self._ga4(client, pages, crawler)
                elif pid == "gsc":
                    await self._gsc(client, pages, crawler)
                elif pid == "psi":
                    await self._each(pid, indexable[: int(self.conf(pid)["limit"] or 100)], 4, lambda p: self._psi_page(client, p))
                elif pid == "majestic":
                    await self._majestic(client, pages)
                elif pid == "ahrefs":
                    await self._each(pid, pages[: int(self.conf(pid)["limit"] or 100)], 2, lambda p: self._ahrefs_page(client, p))
                elif pid == "moz":
                    await self._moz_pages(client, pages)
                elif BY_ID[pid].get("ai"):
                    await self._run_prompts(client, pid, crawler, indexable)
        except Exception as e:
            self._fail(pid, e)
        finally:
            self.state[pid]["running"] = False

    async def _each(self, pid, pages, concurrency, fn):
        self._begin(pid, len(pages))
        sem = asyncio.Semaphore(concurrency)

        async def one(p):
            async with sem:
                if not self.state[pid]["running"]:
                    return
                try:
                    await fn(p)
                except Exception as e:
                    self._fail(pid, e)
                self.state[pid]["done"] += 1

        await asyncio.gather(*(one(p) for p in pages))

    def stop(self, pid=None):
        for k, st in self.state.items():
            if pid in (None, k):
                st["running"] = False

    # Google Analytics 4: one report for every page path, matched by host + path
    async def _ga4(self, client, pages, crawler):
        c = self.conf("ga4")
        self._begin("ga4", 1)
        metrics = ["sessions", "activeUsers", "screenPageViews", "engagementRate", "bounceRate", "averageSessionDuration", "keyEvents"]
        rows, offset = [], 0
        while True:
            data = await self._gget(client, "ga4", f'https://analyticsdata.googleapis.com/v1beta/properties/{c["property"]}:runReport', method="POST",
                                    json={"dateRanges": [{"startDate": f'{int(c["days"] or 30)}daysAgo', "endDate": "today"}],
                                          "dimensions": [{"name": "hostName"}, {"name": "pagePath"}],
                                          "metrics": [{"name": m} for m in metrics], "limit": 100000, "offset": offset})
            batch = data.get("rows", [])
            rows += batch
            offset += len(batch)
            if not batch or offset >= int(data.get("rowCount", 0)):
                break
        agg = {}
        for row in rows:
            host = row["dimensionValues"][0]["value"].lower()
            host = host[4:] if host.startswith("www.") else host
            key = host + row["dimensionValues"][1]["value"].split("?")[0]
            vals = [_num(v["value"]) or 0 for v in row["metricValues"]]
            a = agg.setdefault(key, [0.0] * len(metrics) + [0.0])
            s = vals[0]
            for i in (0, 1, 2, 6):
                a[i] += vals[i]
            for i in (3, 4, 5):  # session-weighted averages
                a[i] += vals[i] * s
        known = {url_key(p["url"]) for p in crawler.pages.values()}
        base = urlparse(crawler.start_url)
        for key, a in agg.items():
            if a[0] > 0 and key not in known and "(not set)" not in key:
                host, _, rest = key.partition("/")
                url = crawler.norm(f"{base.scheme}://{base.hostname if url_key(crawler.start_url).startswith(host + '/') else host}/{rest}")
                if url and crawler.is_internal(url):
                    crawler.api_urls.setdefault(url, set()).add("ga4")
        for p in pages:
            a = agg.get(url_key(p["url"]))
            s = a[0] if a else 0
            p.update(ga_sessions=int(a[0]) if a else 0, ga_users=int(a[1]) if a else 0, ga_views=int(a[2]) if a else 0,
                     ga_key_events=round(a[6], 2) if a else 0,
                     ga_engagement_rate=round(a[3] / s, 4) if s else None, ga_bounce_rate=round(a[4] / s, 4) if s else None,
                     ga_avg_session_duration=round(a[5] / s, 1) if s else None)
        self.state["ga4"].update(done=1, message=f"{len(rows)} linhas")

    # Search Console: search analytics by page
    async def _gsc(self, client, pages, crawler):
        c = self.conf("gsc")
        self._begin("gsc", 1)
        end = date.today() - timedelta(days=2)
        start = end - timedelta(days=int(c["days"] or 28))
        url = "https://www.googleapis.com/webmasters/v3/sites/" + quote(c["site_url"], safe="") + "/searchAnalytics/query"
        found, start_row = {}, 0
        while True:
            data = await self._gget(client, "gsc", url, method="POST",
                                    json={"startDate": start.isoformat(), "endDate": end.isoformat(), "dimensions": ["page"],
                                          "rowLimit": 25000, "startRow": start_row})
            rows = data.get("rows", [])
            for r in rows:
                found[url_key(r["keys"][0])] = r
            start_row += len(rows)
            if len(rows) < 25000:
                break
        known = {url_key(p["url"]) for p in crawler.pages.values()}
        for key, r in found.items():
            url = crawler.norm(r["keys"][0])
            if key not in known and url and crawler.is_internal(url):
                crawler.api_urls.setdefault(url, set()).add("gsc")
        for p in pages:
            r = found.get(url_key(p["url"]))
            p.update(gsc_clicks=int(r["clicks"]) if r else 0, gsc_impressions=int(r["impressions"]) if r else 0,
                     gsc_ctr=round(r["ctr"], 4) if r else 0, gsc_position=round(r["position"], 1) if r else None)
        self.state["gsc"].update(done=1, message=f"{len(found)} URLs")

    async def _psi_page(self, client, p):
        res = await psi_fetch(client, p["url"], self.conf("psi")["strategy"], self.conf("psi")["key"])
        p.update(res)
        if res.get("psi_error"):
            raise IntegrationError(res["psi_error"])

    async def _majestic(self, client, pages):
        c = self.conf("majestic")
        self._begin("majestic", len(pages))
        for i in range(0, len(pages), 100):
            chunk = pages[i:i + 100]
            params = {"app_api_key": c["api_key"], "cmd": "GetIndexItemInfo", "items": len(chunk), "datasource": c["datasource"]}
            params.update({f"item{j}": p["url"] for j, p in enumerate(chunk)})
            try:
                j = (await client.get("https://api.majestic.com/api/json", params=params)).json()
                if j.get("Code") != "OK":
                    raise IntegrationError(j.get("ErrorMessage") or j.get("Code"))
                for p, d in zip(chunk, j["DataTables"]["Results"]["Data"]):
                    p.update(mj_trust_flow=d.get("TrustFlow"), mj_citation_flow=d.get("CitationFlow"),
                             mj_ext_backlinks=d.get("ExtBackLinks"), mj_ref_domains=d.get("RefDomains"))
            except Exception as e:
                self._fail("majestic", e)
            self.state["majestic"]["done"] += len(chunk)

    async def _ahrefs_page(self, client, p):
        h = {"Authorization": f'Bearer {self.conf("ahrefs")["api_key"]}'}
        params = {"target": p["url"], "mode": "exact", "date": date.today().isoformat()}
        r = await client.get("https://api.ahrefs.com/v3/site-explorer/backlinks-stats", headers=h, params=params)
        if r.status_code != 200:
            raise IntegrationError(f"HTTP {r.status_code}: {r.text[:200]}")
        m = r.json().get("metrics", {})
        p.update(ah_backlinks=m.get("live"), ah_refdomains=m.get("live_refdomains"))
        r = await client.get("https://api.ahrefs.com/v3/site-explorer/metrics", headers=h, params=params)
        if r.status_code == 200:
            m = r.json().get("metrics", {})
            p.update(ah_org_traffic=m.get("org_traffic"), ah_org_keywords=m.get("org_keywords"))

    async def _moz(self, client, c, targets):
        kw = {"json": {"targets": targets}}
        if c.get("access_id") and c.get("secret_key"):
            kw["auth"] = (c["access_id"], c["secret_key"])
        elif c.get("token"):
            kw["headers"] = {"x-moz-token": c["token"]}
        else:
            raise IntegrationError("Informe Access ID + Secret Key ou um token")
        r = await client.post("https://lsapi.seomoz.com/v2/url_metrics", **kw)
        if r.status_code != 200:
            raise IntegrationError(f"HTTP {r.status_code}: {r.text[:200]}")
        return r.json().get("results", [])

    async def _moz_pages(self, client, pages):
        c = self.conf("moz")
        self._begin("moz", len(pages))
        for i in range(0, len(pages), 50):
            chunk = pages[i:i + 50]
            try:
                for p, d in zip(chunk, await self._moz(client, c, [p["url"] for p in chunk])):
                    p.update(moz_pa=d.get("page_authority"), moz_da=d.get("domain_authority"), moz_spam_score=d.get("spam_score"),
                             moz_ext_pages=d.get("external_pages_to_page"), moz_root_domains=d.get("root_domains_to_page"))
            except Exception as e:
                self._fail("moz", e)
            self.state["moz"]["done"] += len(chunk)

    # ---------- AI providers ----------
    @staticmethod
    def page_content(crawler, p, kind, max_chars):
        if kind == "html":
            text = crawler.source(p["url"], rendered=bool(p.get("_rendered"))) or ""
        elif kind == "title_meta":
            text = f"Title: {p['title']}\nMeta description: {p['meta_desc']}\nH1: {p['h1_1']}"
        elif kind == "custom":
            text = "\n".join(str(v) for k, v in p.items() if k.startswith("ex") and k[2:].isdigit() and v)
        else:
            text = crawler.text_of(p)
        return text[:max_chars]

    @staticmethod
    def fill_prompt(template, p, content):
        if any("{" + k + "}" in template for k in ("url", "title", "meta", "h1", "text")):
            out = template
            for k, v in {"url": p["url"], "title": p["title"], "meta": p["meta_desc"], "h1": p["h1_1"], "text": content}.items():
                out = out.replace("{" + k + "}", v or "")
            return out
        return template.rstrip() + "\n\n" + content  # SF style: prompt followed by the selected page content

    async def _run_prompts(self, client, pid, crawler, pages):
        c = self.conf(pid)
        lim, max_chars = int(c.get("limit") or 100), int(c.get("max_chars") or 4000)
        jobs = []
        for i, pr in enumerate(self.prompts(pid), 1):
            seg = self._segments.get(pr.get("segment") or "")
            subset = [p for p in pages if not seg or seg.search(p["url"])][:lim]
            jobs += [(i, pr, p) for p in subset]
        self._begin(pid, len(jobs))
        sem = asyncio.Semaphore(3)
        embedded = set()

        async def one(i, pr, p):
            async with sem:
                if not self.state[pid]["running"]:
                    return
                try:
                    content = self.page_content(crawler, p, pr.get("content", "page_text"), max_chars)
                    await self._throttle(pid)
                    if pr.get("type") == "embeddings":
                        vec = await self.embed(client, pid, pr.get("model"), content)
                        p.setdefault("_emb", {})[f"{pid}_{i}"] = vec
                        p[f"ai_{pid}_{i}"] = f"[{len(vec)} dimensões]"
                        embedded.add(i)
                    else:
                        cc = dict(c, model=pr.get("model") or c.get("model"))
                        out = await AI_CALLS[pid](self, client, cc, self.fill_prompt(pr.get("prompt", ""), p, content))
                        p[f"ai_{pid}_{i}"] = (out or "").strip()[:4000]
                except Exception as e:
                    p[f"ai_{pid}_{i}"] = f"[erro] {str(e)[:200]}"
                    self._fail(pid, e)
                self.state[pid]["done"] += 1

        await asyncio.gather(*(one(*j) for j in jobs))
        for i in sorted(embedded):  # embeddings power semantic similarity / search / cluster map
            pr = self.prompts(pid)[i - 1]
            await asyncio.to_thread(crawler.apply_embeddings, f"{pid}_{i}", (pid, pr.get("model")))

    async def embed(self, client, pid, model, text):
        c = self.conf(pid)
        if pid == "openai":
            r = await client.post(c["base_url"].rstrip("/") + "/embeddings", headers={"Authorization": f'Bearer {c["api_key"]}'},
                                  json={"model": model or "text-embedding-3-small", "input": text or " "})
            if r.status_code != 200:
                raise IntegrationError(f"HTTP {r.status_code}: {r.text[:200]}")
            return r.json()["data"][0]["embedding"]
        if pid == "gemini":
            m = model or "text-embedding-004"
            r = await client.post(f"https://generativelanguage.googleapis.com/v1beta/models/{m}:embedContent",
                                  headers={"x-goog-api-key": c["api_key"]}, json={"content": {"parts": [{"text": text or " "}]}})
            if r.status_code != 200:
                raise IntegrationError(f"HTTP {r.status_code}: {r.text[:200]}")
            return r.json()["embedding"]["values"]
        if pid == "ollama":
            r = await client.post(c["base_url"].rstrip("/") + "/api/embed", json={"model": model or "nomic-embed-text", "input": text or " "}, timeout=300)
            if r.status_code != 200:
                raise IntegrationError(f"HTTP {r.status_code}: {r.text[:200]}")
            return r.json()["embeddings"][0]
        raise IntegrationError("A Anthropic não oferece embeddings; use OpenAI, Gemini ou Ollama")

    async def embed_query(self, embedder, text):
        pid, model = embedder
        async with httpx.AsyncClient(timeout=120) as client:
            return await self.embed(client, pid, model, text)

    async def test_prompt(self, pid, prompt, page, crawler):
        c = self.conf(pid)
        content = self.page_content(crawler, page, prompt.get("content", "page_text"), int(c.get("max_chars") or 4000))
        async with httpx.AsyncClient(timeout=180) as client:
            if prompt.get("type") == "embeddings":
                vec = await self.embed(client, pid, prompt.get("model"), content)
                return dict(sent=content[:3000], response=f"[{len(vec)} dimensões] " + ", ".join(f"{x:.4f}" for x in vec[:8]) + " …")
            cc = dict(c, model=prompt.get("model") or c.get("model"))
            full = self.fill_prompt(prompt.get("prompt", ""), page, content)
            return dict(sent=full[:3000], response=(await AI_CALLS[pid](self, client, cc, full) or "").strip())

    async def _throttle(self, pid):
        rpm = float(self.conf(pid).get("rpm") or 0)
        if rpm <= 0:
            return
        lock = self._locks.setdefault(pid, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            wait = self._next_call.get(pid, 0) - now
            self._next_call[pid] = max(now, self._next_call.get(pid, 0)) + 60 / rpm
        if wait > 0:
            await asyncio.sleep(wait)

    async def js_openai(self, req):
        """Bridge for seoSpider.openai(prompt, content, options) in Custom JavaScript snippets.
        The API key stays in Python; the crawled page never sees it."""
        c = self.conf("openai")
        if not self.connected("openai"):
            raise IntegrationError("Conecte a OpenAI na aba API (cartão OpenAI) para usar seoSpider.openai")
        opts = req.get("options") or {}
        text = req.get("prompt", "") + ("\n\n" + req["content"] if req.get("content") else "")
        content = text
        if opts.get("image"):
            content = [{"type": "text", "text": text},
                       {"type": "image_url", "image_url": {"url": await self._image_data_url(opts["image"])}}]
        body = {"model": opts.get("model") or c["model"], "messages": [{"role": "user", "content": content}]}
        if opts.get("system"):
            body["messages"].insert(0, {"role": "system", "content": str(opts["system"])})
        for k in ("temperature", "max_tokens"):
            if k in opts:
                body[k] = opts[k]
        await self._throttle("openai")
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(c["base_url"].rstrip("/") + "/chat/completions",
                                  headers={"Authorization": f'Bearer {c["api_key"]}'}, json=body)
        if r.status_code != 200:
            try:
                msg = r.json().get("error", {}).get("message", r.text[:200])
            except ValueError:
                msg = r.text[:200]
            raise IntegrationError(f"OpenAI HTTP {r.status_code}: {msg}")
        return r.json()["choices"][0]["message"]["content"]

    @staticmethod
    async def _image_data_url(url):
        if str(url).startswith("data:"):
            return url
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            r = await client.get(url)
        if r.status_code != 200 or len(r.content) > 20 * 1024 * 1024:
            raise IntegrationError(f"Não foi possível baixar a imagem ({r.status_code})")
        ctype = r.headers.get("content-type", "image/jpeg").split(";")[0]
        return f"data:{ctype};base64," + base64.b64encode(r.content).decode()

    async def _openai(self, client, c, prompt):
        r = await client.post(c["base_url"].rstrip("/") + "/chat/completions", headers={"Authorization": f'Bearer {c["api_key"]}'},
                              json={"model": c["model"], "messages": [{"role": "user", "content": prompt}]})
        if r.status_code != 200:
            raise IntegrationError(f"HTTP {r.status_code}: {r.text[:200]}")
        return r.json()["choices"][0]["message"]["content"]

    async def _gemini(self, client, c, prompt):
        r = await client.post(f'https://generativelanguage.googleapis.com/v1beta/models/{c["model"]}:generateContent',
                              headers={"x-goog-api-key": c["api_key"]}, json={"contents": [{"parts": [{"text": prompt}]}]})
        if r.status_code != 200:
            raise IntegrationError(f"HTTP {r.status_code}: {r.text[:200]}")
        parts = r.json().get("candidates", [{}])[0].get("content", {}).get("parts", [])
        return "".join(x.get("text", "") for x in parts)

    async def _ollama(self, client, c, prompt):
        r = await client.post(c["base_url"].rstrip("/") + "/api/generate", json={"model": c["model"], "prompt": prompt, "stream": False}, timeout=300)
        if r.status_code != 200:
            raise IntegrationError(f"HTTP {r.status_code}: {r.text[:200]}")
        return r.json().get("response", "")

    async def _anthropic(self, client, c, prompt):
        import anthropic
        model = c["model"]
        kw = {"model": model, "max_tokens": 16000, "messages": [{"role": "user", "content": prompt}]}
        if model in _CLAUDE_EFFORT:
            kw["output_config"] = {"effort": "low"}  # short per-page answers
        api = anthropic.AsyncAnthropic(api_key=c["api_key"])
        try:
            if model in _CLAUDE_FALLBACK:
                resp = await api.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kw)
            else:
                resp = await api.messages.create(**kw)
        except anthropic.AuthenticationError:
            raise IntegrationError("Chave de API da Anthropic inválida")
        except anthropic.RateLimitError:
            raise IntegrationError("Anthropic: limite de requisições atingido")
        except anthropic.APIStatusError as e:
            raise IntegrationError(f"Anthropic HTTP {e.status_code}: {e.message}")
        except anthropic.APIConnectionError:
            raise IntegrationError("Anthropic: erro de conexão")
        if resp.stop_reason == "refusal":
            raise IntegrationError("Anthropic recusou a solicitação para esta página")
        return "".join(b.text for b in resp.content if b.type == "text")


AI_CALLS = {"openai": Integrations._openai, "gemini": Integrations._gemini,
            "ollama": Integrations._ollama, "anthropic": Integrations._anthropic}


async def psi_fetch(client, url, strategy, key):
    params = {"url": url, "strategy": strategy, "category": "performance"}
    if key:
        params["key"] = key
    try:
        r = await client.get(PSI_URL, params=params, timeout=120)
        j = r.json()
    except (httpx.HTTPError, ValueError) as e:
        return dict(psi_error=f"{type(e).__name__}: {e}"[:200], psi_strategy=strategy)
    if r.status_code != 200:
        return dict(psi_error=j.get("error", {}).get("message", str(r.status_code))[:200], psi_strategy=strategy)
    lh = j.get("lighthouseResult", {})
    audits = lh.get("audits", {})
    num = lambda k: audits.get(k, {}).get("numericValue")
    score = lh.get("categories", {}).get("performance", {}).get("score")
    le = j.get("loadingExperience", {}) or {}
    source = "URL"
    if not le.get("metrics") or le.get("origin_fallback"):
        le, source = j.get("originLoadingExperience", {}) or {}, "Origem do site"
    fld = le.get("metrics", {}) or {}
    pct = lambda k: fld.get(k, {}).get("percentile")
    lcp, fcp, si, tbt, cls = num("largest-contentful-paint"), num("first-contentful-paint"), \
        num("speed-index"), num("total-blocking-time"), num("cumulative-layout-shift")
    field_cls = pct("CUMULATIVE_LAYOUT_SHIFT_SCORE")
    f_lcp, f_inp = pct("LARGEST_CONTENTFUL_PAINT_MS"), pct("INTERACTION_TO_NEXT_PAINT")
    f_cls = field_cls / 100 if field_cls is not None else None
    if f_lcp is None and f_inp is None and f_cls is None:
        cwv, source = "Sem dados de campo", ""
    else:  # Google's assessment: every available metric at "good" (LCP <= 2.5s, INP <= 200ms, CLS <= 0.1)
        good = (f_lcp is None or f_lcp <= 2500) and (f_inp is None or f_inp <= 200) and (f_cls is None or f_cls <= 0.1)
        cwv = "Aprovado" if good else "Reprovado"
    opps = [(k, a.get("details", {}).get("overallSavingsMs") or 0) for k, a in audits.items()
            if a.get("details", {}).get("type") == "opportunity" and a.get("score") is not None and a["score"] < 0.9]
    details = []
    for ref in lh.get("categories", {}).get("performance", {}).get("auditRefs", []):
        a = audits.get(ref.get("id"), {})
        if ref.get("group") == "metrics" or a.get("score") is None or a["score"] >= 0.9 \
                or a.get("scoreDisplayMode") in ("notApplicable", "informative", "manual"):
            continue
        d = a.get("details") or {}
        details.append(dict(id=ref["id"], title=a.get("title", ""), display=a.get("displayValue", ""),
                            score=a["score"], savings_ms=round(d.get("overallSavingsMs") or 0),
                            kind="Oportunidade" if d.get("type") == "opportunity" else "Diagnóstico"))
    details.sort(key=lambda x: (-x["savings_ms"], x["score"]))
    return dict(psi_cwv=cwv, psi_field_source=source, _psi_audits=details[:60],
        psi_opps=", ".join(k for k, _ in sorted(opps, key=lambda x: -x[1])),
        psi_savings_ms=round(sum(s for _, s in opps)) if opps else 0,
        psi_score=round(score * 100) if score is not None else None,
        psi_lcp=round(lcp / 1000, 2) if lcp is not None else None,
        psi_fcp=round(fcp / 1000, 2) if fcp is not None else None,
        psi_si=round(si / 1000, 2) if si is not None else None,
        psi_tbt=round(tbt) if tbt is not None else None,
        psi_cls=round(cls, 3) if cls is not None else None,
        psi_field_lcp=pct("LARGEST_CONTENTFUL_PAINT_MS"), psi_field_inp=pct("INTERACTION_TO_NEXT_PAINT"),
        psi_field_cls=field_cls / 100 if field_cls is not None else None,
        psi_strategy=strategy, psi_error="",
    )
