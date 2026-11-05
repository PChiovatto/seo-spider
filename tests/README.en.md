# Tests — SEO Spider

[Português](README.md) · **English**

## Running them

```
tests.bat             fast suite (61 tests, ~16s)
tests.bat -v          verbose
tests.bat full        suite + regression check (runs a real crawl)
tests.bat baseline    records the regression baseline again
```

Or directly:

```
.venv\Scripts\python.exe -m unittest discover -s tests -v
```

No pytest: this uses only the stdlib `unittest`. No new dependencies.

## The two principles

**1. Every derived metric must prove it can vary.**
The bug that started this suite: `js_word_diff_pct` always returned `0.0%`, so a
100% JavaScript site was reported as "JS does not affect this page". Nothing
caught it, because nothing checked whether the metric *could* change.

Each metric has two assertions:
- **it changes** when the data changes → catches a silent constant
- **it does not change** when the data is the same → catches noise

**2. Network failure is a normal case, not an exception.**
Testing only against a healthy site hides the bugs the client runs into. The
crawler must finish with a usable result when half the pages fail.

## Coverage (61 tests)

### `test_metrics.py` — 47 tests

| Area | What is guaranteed |
|---|---|
| `pixel_width` | varies with text and font; stable for the same input |
| `minhash` / `near_duplicates` | different text → different signatures; duplicate pair found |
| `link_score` | more inlinks score higher; never constant; 0–100 scale |
| `semantic_index` / `semantic_pairs` | different docs do not give 1.0; identical docs do |
| `flesch` | plain text > dense text; short text → `None` |
| `clean_text` | collapses spaces, keeps single spaces, handles `\n`/`\t` |
| `_ngrams` | counts change with the text; a known bigram is counted |
| Extraction | clean title/H1, coherent `title_len`, word_count and text_ratio vary |
| **JS parity** | diff is **non-zero** when JS adds content; **zero** when identical |
| **srcset** | responsive variants collected; `img_srcset=False` turns it off; default `True` |
| `validate_html` | missing head/body and invalid elements in head are detected |

### `test_failures.py` — 14 tests

Disposable local HTTP server; nothing leaves the machine.

| Scenario | What is guaranteed |
|---|---|
| Page 500 / 503 | crawl finishes; the error is recorded, not raised |
| Timeout | does not hang the crawl; finishes within the limit |
| Dropped connection | crawl survives |
| Truncated body (lying Content-Length) | crawl survives |
| Malformed HTML | still parsed |
| Redirect | chain followed, destination recorded |
| Infinite redirect loop | bounded by `max_urls`, does not explode |
| Unreachable host | status 0 recorded, no crash |
| State after failure | `analyze()`, `snapshot()` and `progress()` keep working |
| `stop()` mid-crawl | crawl ends as `stopped`/`finished` |

## Regression (`baseline.py`)

The crawler has 162 issue rules. A refactor can silently change how many URLs
each rule finds. The baseline pins those numbers.

```
python -m tests.baseline record --url https://example.com --max-urls 200
python -m tests.baseline check     # fails (exit 1) when there is drift
python -m tests.baseline diff      # shows the diff without failing
```

`baseline.json` stores **counts only** — never page content, never credentials.
It is safe to commit.

Output when there is drift:

```
regression check: DRIFT DETECTED
  changed  Title ausente: 99 -> 0
  gone     Regra inventada: was 7 URLs
```

## Proof that the suites work

Neither suite was written just to "pass":

- **Metrics**: the original `js_word_diff_pct` bug was **re-injected** on
  purpose. The suite failed immediately (`-4.0 != 0`). Code restored, 47/47.
- **Regression**: the baseline was **tampered with** on purpose. `check`
  reported `DRIFT DETECTED` and exited with code 1. Baseline re-recorded, OK.

A suite that never failed proves nothing. These two have already failed on purpose.

## When adding a new metric

Before writing the test, answer: *"if this metric always returned the same
value, would any test break?"*. If the answer is no, the test is incomplete.
