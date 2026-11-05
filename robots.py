"""robots.txt parser/matcher following Google's rules (RFC 9309): most specific user-agent group,
`*` / `$` wildcards, longest matching rule wins, Allow wins ties. Unlike urllib.robotparser it reports
which line allowed or blocked a URL, which the robots.txt tester shows."""
import re
from urllib.parse import unquote, urlparse


def _product_token(user_agent):
    """'Mozilla/5.0 (compatible; Googlebot/2.1; +http://...)' -> tokens that groups can match."""
    return user_agent.lower()


def _rule_regex(path):
    anchored = path.endswith("$")
    if anchored:
        path = path[:-1]
    rx = "".join(".*" if ch == "*" else re.escape(ch) for ch in path)
    return re.compile("^" + rx + ("$" if anchored else ""))


class Robots:
    def __init__(self, text):
        self.text = text or ""
        self.groups = []      # [{"agents": [...], "rules": [(allow, pattern, regex, lineno, line)], "delay": float|None}]
        self._sitemaps = []
        self._parse()

    def _parse(self):
        group, last_was_agent = None, False
        for lineno, raw in enumerate(self.text.splitlines(), 1):
            line = raw.split("#", 1)[0].strip()
            if ":" not in line:
                continue
            key, value = (x.strip() for x in line.split(":", 1))
            key = key.lower()
            if key == "user-agent":
                if group is None or not last_was_agent:
                    group = {"agents": [], "rules": [], "delay": None}
                    self.groups.append(group)
                group["agents"].append(value.lower())
                last_was_agent = True
                continue
            last_was_agent = False
            if key == "sitemap":
                self._sitemaps.append(value)
            elif group is None:
                continue
            elif key in ("allow", "disallow"):
                if value:  # an empty Disallow allows everything: no rule
                    group["rules"].append((key == "allow", value, _rule_regex(value), lineno, raw.strip()))
            elif key == "crawl-delay":
                try:
                    group["delay"] = float(value)
                except ValueError:
                    pass

    def _groups_for(self, user_agent):
        ua = _product_token(user_agent)
        best, best_len = [], 0
        for g in self.groups:
            for a in g["agents"]:
                if a != "*" and a in ua:
                    if len(a) > best_len:
                        best, best_len = [g], len(a)
                    elif len(a) == best_len and g not in best:
                        best.append(g)
        if best:
            return best
        return [g for g in self.groups if "*" in g["agents"]]

    def check(self, url, user_agent):
        """Returns (allowed, matching_line or None, lineno or None)."""
        p = urlparse(url)
        path = unquote(p.path or "/") + (("?" + p.query) if p.query else "")
        if path == "/robots.txt":
            return True, None, None
        best = None
        for g in self._groups_for(user_agent):
            for allow, pattern, rx, lineno, line in g["rules"]:
                if rx.match(path):
                    key = (len(pattern), allow)
                    if best is None or key > best[0]:
                        best = (key, allow, line, lineno)
        if best is None:
            return True, None, None
        return best[1], best[2], best[3]

    def can_fetch(self, user_agent, url):
        return self.check(url, user_agent)[0]

    def crawl_delay(self, user_agent):
        delays = [g["delay"] for g in self._groups_for(user_agent) if g["delay"]]
        return max(delays) if delays else None

    def site_maps(self):
        return list(self._sitemaps)
