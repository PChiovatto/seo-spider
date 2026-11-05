"""Regression baseline for the SEO Spider crawler.

Why this exists: the crawler has 162 issue rules over thousands of pages. Any
refactor can silently change how many URLs a rule matches, and nothing would
notice. This module pins the expected counts to a JSON file so a drift becomes
a test failure instead of a surprise for the client.

Usage
-----
    # 1. record a new baseline from a live crawl
    python -m tests.baseline record --url https://exemplo.com --max-urls 200

    # 2. check the current code against the recorded baseline
    python -m tests.baseline check

    # 3. see the diff between current code and baseline, without failing
    python -m tests.baseline diff

The baseline stores counts only (never page content, never credentials), so it
is safe to commit.
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE = Path(__file__).resolve().parent / "baseline.json"
DEFAULT_URL = "https://example.com/"


def _summary(crawler):
    """Counts that must stay stable: per-issue URL counts + structural totals."""
    issues = crawler.analyze()
    pages = list(crawler.pages.values())
    html = [p for p in pages if p.get("content_type") == "text/html" and p.get("status") == 200]
    return {
        "start_url": crawler.start_url,
        "totals": {
            "pages": len(pages),
            "html": len(html),
            "external": len(crawler.external),
            "images": len(crawler.images),
        },
        "issues": {i["name"]: i["count"] for i in issues},
    }


async def _crawl(url, max_urls, render_js=False):
    sys.path.insert(0, str(ROOT))
    from app import CrawlRequest, make_crawler
    c = make_crawler(CrawlRequest(start_url=url, max_urls=max_urls, max_depth=5,
                                  auto_analyse=True, check_external=True,
                                  check_images=True, render_js=render_js,
                                  concurrency=4, timeout=25))
    await c.run()
    if c.status == "error":
        raise SystemExit(f"crawl failed: {c.error}")
    return c


def cmd_record(args):
    c = asyncio.run(_crawl(args.url, args.max_urls, args.render_js))
    data = _summary(c)
    data["meta"] = {"max_urls": args.max_urls, "render_js": args.render_js}
    BASELINE.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    live = {k: v for k, v in data["issues"].items() if v}
    print(f"baseline recorded: {BASELINE}")
    print(f"  pages={data['totals']['pages']} html={data['totals']['html']} "
          f"rules_with_hits={len(live)} total_hits={sum(live.values())}")
    return 0


def _compare(expected, current):
    """Return (added, removed, changed) between two issue-count maps."""
    added = {k: current[k] for k in current.keys() - expected.keys() if current[k]}
    removed = {k: expected[k] for k in expected.keys() - current.keys() if expected[k]}
    changed = {k: (expected[k], current[k]) for k in expected.keys() & current.keys()
               if expected[k] != current[k]}
    return added, removed, changed


def _print_diff(expected, current):
    added, removed, changed = _compare(expected["issues"], current["issues"])
    lines = []
    for k, v in expected["totals"].items():
        cur = current["totals"].get(k)
        if cur != v:
            lines.append(f"  total {k}: {v} -> {cur}")
    for k, (a, b) in sorted(changed.items()):
        lines.append(f"  changed  {k}: {a} -> {b}")
    for k, v in sorted(added.items()):
        lines.append(f"  new rule {k}: {v} URLs")
    for k, v in sorted(removed.items()):
        lines.append(f"  gone     {k}: was {v} URLs")
    return lines


def cmd_check(args):
    if not BASELINE.exists():
        raise SystemExit(f"no baseline at {BASELINE}; run: python -m tests.baseline record")
    expected = json.loads(BASELINE.read_text(encoding="utf-8"))
    url = args.url or expected.get("start_url") or DEFAULT_URL
    max_urls = args.max_urls or expected.get("meta", {}).get("max_urls", 100)
    c = asyncio.run(_crawl(url, max_urls, expected.get("meta", {}).get("render_js", False)))
    current = _summary(c)
    lines = _print_diff(expected, current)
    if not lines:
        print("regression check: OK (baseline matches)")
        return 0
    print("regression check: DRIFT DETECTED")
    for line in lines:
        print(line)
    return 1


def cmd_diff(args):
    if not BASELINE.exists():
        raise SystemExit(f"no baseline at {BASELINE}")
    expected = json.loads(BASELINE.read_text(encoding="utf-8"))
    url = args.url or expected.get("start_url") or DEFAULT_URL
    max_urls = args.max_urls or expected.get("meta", {}).get("max_urls", 100)
    c = asyncio.run(_crawl(url, max_urls, expected.get("meta", {}).get("render_js", False)))
    lines = _print_diff(expected, _summary(c))
    print("\n".join(lines) if lines else "no differences")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Regression baseline for the SEO Spider")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("record", "check", "diff"):
        p = sub.add_parser(name)
        p.add_argument("--url", default=None)
        p.add_argument("--max-urls", type=int, default=None)
        p.add_argument("--render-js", action="store_true")
    args = ap.parse_args()
    return {"record": cmd_record, "check": cmd_check, "diff": cmd_diff}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
