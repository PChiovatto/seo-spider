# Changelog

[Português](CHANGELOG.md) · **English** · [Español](CHANGELOG.es.md)

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [1.0.0] - 2026-11-05

First public release of SEO Spider: a technical SEO crawler that runs 100% locally.

### Added

- Spider mode and List mode crawling, scoped to the subdomain, a subfolder or all subdomains.
- `robots.txt` support that follows Google's rules (RFC 9309) and `Crawl-delay`, with a robots.txt tester.
- XML sitemaps, regex include/exclude filters and parameter stripping (`utm_*`, `gclid`…).
- JavaScript rendering with Chromium (Playwright), raw vs. rendered HTML comparison and WAF block handling.
- Basic auth, form-based login, custom headers and cookies, proxy and configurable User-Agent.
- Screaming Frog–style tabs: Internal, External, Security, Response Codes, URL, Page Titles, Meta Description, H1, H2, Content, Images, Canonicals, Pagination, Hreflang, Structured Data, Links and more.
- Issues panel (Issues, Warnings, Opportunities), pixel width of titles/descriptions and SERP snippet preview.
- Exact and near-duplicate content (MinHash), semantic similarity, redirect and canonical chains, orphan pages.
- Structured data validation against the schema.org vocabulary and accessibility audit with axe-core.
- Spelling and grammar, n-grams, link score and custom extraction (CSS/XPath/regex) with a visual inspector.
- Visualizations: link diagram, directory tree, crawl tree, charts and content clusters.
- Optional integrations: Search Console, GA4, PageSpeed Insights, Majestic, Ahrefs, Moz and AI providers.
- Excel and CSV export, reports, XML sitemap generation, saved crawls and crawl comparison.
- Crawl scheduling, command-line interface (CLI) and an MCP server for AI assistants.
- Interface in Portuguese, English and Spanish; Windows, Linux and macOS support.

[1.0.0]: https://github.com/PChiovatto/seo-spider/releases/tag/v1.0.0
