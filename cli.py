"""SEO Spider — command line (headless) crawling, e.g. for the Windows Task Scheduler.

Examples:
  cli.bat https://www.example.com --export xlsx,issues --output D:/relatorios
  cli.bat --config meu-crawl.json --export report:overview,broken
  cli.bat --list urls.txt --export xlsx --lang en
  cli.bat https://www.example.com --project site --compare-previous --skip-empty

Export kinds: xlsx, issues, all-links, broken, external, images-missing-alt, images-all, skipped,
inlinks-3xx, inlinks-4xx, inlinks-5xx, inlinks-noresp, hreflang, structured-data, cookies,
accessibility, headers, and report:<overview|redirect-chains|canonical-chains|insecure|orphans|serp|
migration|accessibility-summary|headers-summary|cookie-summary|psi-opportunities>.
"""
import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description="SEO Spider — crawl sem interface",
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("url", nargs="?", help="URL inicial (modo spider)")
    ap.add_argument("--config", help="configuração exportada pelo app (Configuração > Exportar p/ CLI)")
    ap.add_argument("--list", help="arquivo de texto com uma URL por linha (modo lista)")
    ap.add_argument("--max-urls", type=int)
    ap.add_argument("--render-js", action="store_true", help="renderizar JavaScript (Chromium)")
    ap.add_argument("--export", default="xlsx", help="exportações separadas por vírgula (padrão: xlsx)")
    ap.add_argument("--output", help="pasta de saída (padrão: data/exports/cli-<data>)")
    ap.add_argument("--lang", default="pt", choices=["pt", "en", "es"], help="idioma das exportações")
    ap.add_argument("--project", default="", help="projeto do crawl salvo")
    ap.add_argument("--no-save", action="store_true", help="não salvar o crawl na lista de crawls salvos")
    ap.add_argument("--skip-empty", action="store_true", help="não criar arquivos para exportações/relatórios vazios")
    ap.add_argument("--compare-previous", action="store_true",
                    help="comparar com o crawl salvo mais recente do mesmo --project e exportar as diferenças")
    a = ap.parse_args()

    from fastapi import HTTPException
    from app import EXPORT_DIR, CrawlRequest, compare_files, export_files, make_crawler, previous_in_project
    import storage

    cfg = {}
    if a.config:
        data = json.loads(Path(a.config).read_text(encoding="utf-8"))
        if data.get("format") == "seo-spider-config":
            ap.error("este arquivo é um perfil da interface; use o botão 'Exportar p/ CLI' na janela de configuração")
        cfg = data.get("config", data)
    if a.url:
        cfg.update(start_url=a.url, mode="spider")
    if a.list:
        cfg.update(mode="list", url_list=[l.strip() for l in Path(a.list).read_text(encoding="utf-8").splitlines() if l.strip()])
    if a.max_urls:
        cfg["max_urls"] = a.max_urls
    if a.render_js:
        cfg["render_js"] = True
    if not cfg.get("start_url") and not cfg.get("url_list"):
        ap.error("informe uma URL, --list ou --config")
    try:
        c = make_crawler(CrawlRequest(**cfg))
    except HTTPException as e:
        sys.exit(f"Erro: {e.detail}")
    c.project = a.project

    async def go():
        task = asyncio.create_task(c.run())
        while not task.done():
            await asyncio.sleep(1)
            p = c.progress()
            print(f"\r{p['phase'] or 'Rastreando'} — {p['crawled']} URLs   ", end="", flush=True)
        await task

    t0 = time.time()
    asyncio.run(go())
    print(f"\nConcluído em {time.time() - t0:.0f}s: {len(c.pages)} URLs ({c.status})")
    if c.status == "error":
        sys.exit(f"Erro: {c.error}")
    if not a.no_save:
        storage.save(c)
        print("Crawl salvo:", c.crawl_name)
    kinds = [k.strip() for k in a.export.split(",") if k.strip()]
    out = Path(a.output) if a.output else EXPORT_DIR / f"cli-{time.strftime('%Y%m%d-%H%M%S')}"
    files = []
    if kinds:
        try:
            files = export_files(c, kinds, out, a.lang, a.skip_empty)
        except HTTPException as e:
            sys.exit(f"Erro na exportação: {e.detail}")
    if a.compare_previous:
        prev = previous_in_project(c)
        if prev is None:
            print("Comparação: nenhum crawl anterior no projeto", repr(c.project or ""))
        else:
            cf, summ = compare_files(prev, c, out, a.lang, a.skip_empty)
            files += cf
            print(f"Comparado com '{summ['previous_name']}': {summ['worse']} problemas pioraram, {summ['better']} melhoraram, "
                  f"{summ['new_urls']} URLs novas, {summ['missing_urls']} ausentes")
    if files:
        print("Arquivos em", out)
        for f in files:
            print("  ", f)


if __name__ == "__main__":
    main()
