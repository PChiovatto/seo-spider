# Testes — SEO Spider

**Português** · [English](README.en.md)

## Como rodar

```
tests.bat             suite rapida (61 testes, ~16s)
tests.bat -v          detalhado
tests.bat full        suite + verificacao de regressao (faz crawl real)
tests.bat baseline    regrava o baseline de regressao
```

Ou direto:

```
.venv\Scripts\python.exe -m unittest discover -s tests -v
```

Sem pytest: usa só `unittest` da stdlib. Nenhuma dependência nova.

## Os dois principios

**1. Toda métrica derivada precisa provar que sabe variar.**
O bug que originou esta suíte: `js_word_diff_pct` sempre retornava `0.0%`, então
um site 100% JavaScript era reportado como "JS não afeta esta página". Nada
pegava, porque nada verificava se a métrica *podia* mudar.

Cada métrica tem duas asserções:
- **varia** quando os dados mudam → pega constante silenciosa
- **não varia** quando os dados são iguais → pega ruído

**2. Falha de rede é caso normal, não exceção.**
Testar só com site saudável esconde os bugs que o cliente encontra. O crawler
precisa terminar com resultado utilizável quando metade das páginas falha.

## Cobertura (61 testes)

### `test_metrics.py` — 47 testes

| Área | O que é garantido |
|---|---|
| `pixel_width` | varia com texto e fonte; estável no mesmo input |
| `minhash` / `near_duplicates` | textos distintos → assinaturas distintas; par duplicado encontrado |
| `link_score` | mais inlinks pontua mais; nunca constante; escala 0–100 |
| `semantic_index` / `semantic_pairs` | docs distintos não dão 1.0; docs iguais dão |
| `flesch` | texto simples > denso; curto → `None` |
| `clean_text` | colapsa espaços, preserva simples, trata `\n`/`\t` |
| `_ngrams` | contagem muda por texto; bigrama conhecido contado |
| Extração | title/H1 limpos, `title_len` coerente, word_count e text_ratio variam |
| **Paridade JS** | diff **não-zero** quando JS adiciona conteúdo; **zero** quando idêntico |
| **srcset** | variantes responsivas coletadas; `img_srcset=False` desliga; default `True` |
| `validate_html` | head/body ausentes e elementos inválidos no head detectados |

### `test_failures.py` — 14 testes

Servidor HTTP local descartável; nada sai da máquina.

| Cenário | O que é garantido |
|---|---|
| Página 500 / 503 | crawl termina; erro é registrado, não levantado |
| Timeout | não trava o crawl; termina dentro do limite |
| Conexão derrubada | crawl sobrevive |
| Corpo truncado (Content-Length mentindo) | crawl sobrevive |
| HTML malformado | ainda é parseado |
| Redirect | cadeia seguida, destino registrado |
| Loop de redirect infinito | limitado por `max_urls`, não explode |
| Host inalcançável | status 0 registrado, sem crash |
| Estado pós-falha | `analyze()`, `snapshot()` e `progress()` continuam funcionando |
| `stop()` no meio | crawl termina como `stopped`/`finished` |

## Regressão (`baseline.py`)

O crawler tem 162 regras de issue. Um refactor pode mudar silenciosamente
quantas URLs cada regra encontra. O baseline fixa esses números.

```
python -m tests.baseline record --url https://exemplo.com --max-urls 200
python -m tests.baseline check     # falha (exit 1) se houve drift
python -m tests.baseline diff      # mostra o diff sem falhar
```

O `baseline.json` guarda **apenas contagens** — nunca conteúdo de página, nunca
credenciais. É seguro versionar.

Saída quando há drift:

```
regression check: DRIFT DETECTED
  changed  Title ausente: 99 -> 0
  gone     Regra inventada: was 7 URLs
```

## Prova de que as suítes funcionam

Nenhuma das duas foi escrita só para "passar":

- **Métricas**: o bug original do `js_word_diff_pct` foi **reinjetado** de
  propósito. A suíte falhou na hora (`-4.0 != 0`). Código restaurado, 47/47.
- **Regressão**: o baseline foi **adulterado** de propósito. O `check` acusou
  `DRIFT DETECTED` e saiu com código 1. Baseline regravado, OK.

Uma suíte que nunca falhou não prova nada. Estas duas já falharam de propósito.

## Ao adicionar uma métrica nova

Antes de escrever o teste, responda: *"se essa métrica retornasse sempre o mesmo
valor, algum teste quebraria?"*. Se a resposta for não, o teste está incompleto.
