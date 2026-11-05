"""End-to-end proof: a WAF-blocked site that httpx cannot reach is now crawled.

Before: certapro.com -> 403 "Bloqueado por WAF (Cloudflare)", 0 pages.
After:  certapro.com -> 200, page parsed, links followed.
"""
import asyncio
import sys

sys.path.insert(0, ".")

from crawler import Crawler, CrawlConfig

URL = "https://certapro.com/"


async def run(fallback):
    c = Crawler(CrawlConfig(start_url=URL, max_urls=3, max_depth=1,
                            auto_analyse=False, check_external=False,
                            check_images=False, concurrency=1, timeout=25,
                            waf_fallback=fallback))
    await c.run()
    return c


async def main():
    off = await run(False)
    p_off = off.pages.get(URL) or {}
    print(f"fallback OFF: status={p_off.get('status')} "
          f"reason={p_off.get('indexability_reason')!r} pages={len(off.pages)}")

    on = await run(True)
    p_on = on.pages.get(URL) or {}
    print(f"fallback ON : status={p_on.get('status')} "
          f"words={p_on.get('word_count')} outlinks={p_on.get('outlinks')} "
          f"title={(p_on.get('title') or '')[:45]!r} pages={len(on.pages)}")

    ok = p_off.get("status") == 403 and p_on.get("status") == 200 and (p_on.get("word_count") or 0) > 0
    print()
    print("RESULTADO:", "FALLBACK FUNCIONA" if ok else "FALLBACK NAO RESOLVEU")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
