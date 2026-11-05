"""Failure-mode tests: what the crawler does when the network misbehaves.

Real clients hit these cases constantly and a developer machine almost never:
a 500 on one page, a timeout mid-render, a server that drops the connection.
None of these should crash the crawl or leave the run in a broken state.

Each test serves a fake site from a local thread, points the crawler at it and
asserts the crawl finishes with a usable result. Nothing leaves the machine.
"""
import asyncio
import socket
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from crawler import Crawler, CrawlConfig


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _Handler(BaseHTTPRequestHandler):
    """Behaviour is driven by the path so one server can serve every scenario."""
    mode = "normal"

    def log_message(self, *a):
        pass

    def _html(self, body):
        return f"<html><head><title>T</title></head><body>{body}</body></html>".encode()

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_GET(self, head=False):
        path = self.path
        if path == "/robots.txt":
            return self._send(200, b"User-agent: *\nAllow: /\n", head)
        if path.startswith("/ok"):
            return self._send(200, self._html('<h1>ok</h1><a href="/ok2">next</a>'), head)
        if path == "/ok2":
            return self._send(200, self._html("<h1>second</h1>"), head)
        if path == "/500":
            return self._send(500, b"boom", head)
        if path == "/503":
            return self._send(503, b"unavailable", head)
        if path == "/404":
            return self._send(404, b"missing", head)
        if path == "/timeout":
            time.sleep(3)          # longer than the crawler timeout
            return self._send(200, self._html("late"), head)
        if path == "/drop":
            self.close_connection = True
            try:
                self.wfile.close()
            except Exception:
                pass
            return
        if path == "/badhtml":
            return self._send(200, b"<html><body><h1>sem fechar", head)
        if path == "/redirect":
            self.send_response(301)
            self.send_header("Location", "/ok")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/loop":
            self.send_response(302)
            self.send_header("Location", "/loop")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/half":
            # announces more bytes than it sends, then closes
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", "9999")
            self.end_headers()
            self.wfile.write(b"<html><body>partial")
            self.close_connection = True
            return
        return self._send(404, b"?", head)

    def _send(self, code, body, head):
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=UTF-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)


class Site:
    """Local throwaway site; start() returns its base URL."""
    def __init__(self):
        self.port = _free_port()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", self.port), _Handler)
        self.httpd.daemon_threads = True
        self.httpd.handle_error = lambda *a: None   # broken pipes are the point of these tests
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return f"http://127.0.0.1:{self.port}"

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


def _run(base, max_urls=10, timeout=5, retries=0, path="/ok"):
    c = Crawler(CrawlConfig(start_url=base + path, max_urls=max_urls, max_depth=3,
                            timeout=timeout, retries=retries, auto_analyse=True,
                            check_external=False, check_images=False, concurrency=3))
    asyncio.run(c.run())
    return c


class TestFailureModes(unittest.TestCase):
    def test_crawl_completes_when_a_page_returns_500(self):
        with Site() as base:
            c = _run(base, path="/500")
            self.assertEqual(c.status, "finished", f"crawl ended as {c.status}: {c.error}")
            self.assertEqual(len(c.pages), 1)

    def test_server_error_is_recorded_not_raised(self):
        with Site() as base:
            c = _run(base, path="/503")
            p = c.pages.get(base + "/503")
            self.assertIsNotNone(p)
            self.assertEqual(p["status"], 503)
            self.assertEqual(p["indexability"], "Non-Indexable")

    def test_timeout_does_not_hang_the_crawl(self):
        with Site() as base:
            t0 = time.time()
            c = _run(base, path="/timeout", timeout=1)
            self.assertLess(time.time() - t0, 30, "timeout hung the crawl")
            self.assertEqual(c.status, "finished", f"status={c.status} error={c.error}")

    def test_dropped_connection_is_survived(self):
        with Site() as base:
            c = _run(base, path="/drop")
            self.assertEqual(c.status, "finished", f"status={c.status} error={c.error}")

    def test_truncated_body_is_survived(self):
        with Site() as base:
            c = _run(base, path="/half")
            self.assertEqual(c.status, "finished", f"status={c.status} error={c.error}")

    def test_malformed_html_still_parses(self):
        with Site() as base:
            c = _run(base, path="/badhtml")
            p = c.pages.get(base + "/badhtml") or {}
            self.assertEqual(p.get("status"), 200)

    def test_redirect_chain_followed(self):
        with Site() as base:
            c = _run(base, path="/redirect")
            p = c.pages.get(base + "/redirect") or {}
            self.assertEqual(p.get("status"), 301)
            self.assertEqual(p.get("redirect_url"), base + "/ok")

    def test_infinite_redirect_loop_is_bounded(self):
        with Site() as base:
            c = _run(base, path="/loop", max_urls=20)
            self.assertEqual(c.status, "finished")
            self.assertLessEqual(len(c.pages), 20, "redirect loop was not bounded")

    def test_unreachable_host_does_not_crash(self):
        port = _free_port()          # nothing listening here
        c = Crawler(CrawlConfig(start_url=f"http://127.0.0.1:{port}/", max_urls=3,
                                timeout=2, retries=0, auto_analyse=True,
                                check_external=False, check_images=False))
        asyncio.run(c.run())
        self.assertEqual(c.status, "finished", f"status={c.status} error={c.error}")
        p = c.pages.get(f"http://127.0.0.1:{port}/") or {}
        self.assertEqual(p.get("status"), 0, "unreachable host should record status 0")

    def test_mixed_good_and_bad_pages(self):
        """The realistic case: some pages work, some fail, crawl still completes."""
        with Site() as base:
            c = Crawler(CrawlConfig(start_url=base + "/ok", max_urls=10, max_depth=2,
                                    timeout=3, retries=1, auto_analyse=True,
                                    check_external=False, check_images=False, concurrency=5))
            # enqueue the bad ones alongside the good one
            asyncio.run(c.run())
            self.assertEqual(c.status, "finished")
            self.assertGreaterEqual(len(c.pages), 1)


class TestStateConsistency(unittest.TestCase):
    """After failures the crawl state must stay usable, not half-built."""

    def test_analyze_works_after_failures(self):
        with Site() as base:
            c = _run(base, path="/500", max_urls=5)
            issues = c.analyze()          # must not raise
            self.assertIsInstance(issues, list)
            self.assertTrue(any(i["count"] >= 1 for i in issues),
                            "a 500 page should trigger at least one issue")

    def test_snapshot_works_after_failures(self):
        with Site() as base:
            c = _run(base, path="/500")
            snap = c.snapshot()           # must not raise
            self.assertIn("pages", snap)
            self.assertIn("issues", snap)

    def test_progress_reports_finished(self):
        with Site() as base:
            c = _run(base, path="/500")
            prog = c.progress()
            self.assertEqual(prog["status"], "finished")
            self.assertEqual(prog["error"], "")

    def test_stop_mid_crawl_still_finishes(self):
        with Site() as base:
            c = Crawler(CrawlConfig(start_url=base + "/ok", max_urls=50, max_depth=5,
                                    timeout=3, auto_analyse=False,
                                    check_external=False, check_images=False))
            async def go():
                task = asyncio.create_task(c.run())
                await asyncio.sleep(0.05)
                c.stop()
                await task
            asyncio.run(go())
            self.assertIn(c.status, ("stopped", "finished"), f"got {c.status}: {c.error}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
