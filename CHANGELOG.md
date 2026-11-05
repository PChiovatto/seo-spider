# Changelog

**Português** · [English](CHANGELOG.en.md) · [Español](CHANGELOG.es.md)

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/);
versão segundo [SemVer](https://semver.org/lang/pt-BR/).

## [1.0.0] - 2026-11-05

Primeira versão pública do SEO Spider: crawler de SEO técnico que roda 100% local.

### Adicionado

- Rastreamento em modo Spider e modo Lista, com escopo por subdomínio, subpasta ou todos os subdomínios.
- Leitura e obediência ao `robots.txt` (regras do Google, RFC 9309) e `Crawl-delay`, com testador de robots.txt.
- Sitemaps XML, filtros de inclusão/exclusão por regex e remoção de parâmetros (`utm_*`, `gclid`…).
- Renderização JavaScript com Chromium (Playwright), comparação HTML bruto × renderizado e contorno de bloqueio de WAF.
- Autenticação básica, login por formulário, cabeçalhos e cookies customizados, proxy e User-Agent configurável.
- Abas de análise no estilo Screaming Frog: Internos, Externos, Segurança, Códigos de resposta, URL, Page Titles, Meta Description, H1, H2, Conteúdo, Imagens, Canonicals, Paginação, Hreflang, Dados estruturados, Links e outras.
- Painel de problemas (Issues, Warnings, Oportunidades), largura em pixels de titles/descriptions e pré-visualização SERP.
- Duplicados exatos e quase-duplicados (MinHash), similaridade semântica, cadeias de redirect e canonical, páginas órfãs.
- Validação de dados estruturados contra o vocabulário schema.org e auditoria de acessibilidade com axe-core.
- Ortografia e gramática, n-gramas, link score e extração customizada (CSS/XPath/regex) com inspetor visual.
- Visualizações: diagrama de links, árvore de diretórios, árvore de rastreamento, gráficos e clusters de conteúdo.
- Integrações opcionais: Search Console, GA4, PageSpeed Insights, Majestic, Ahrefs, Moz e provedores de IA.
- Exportação para Excel e CSV, relatórios, geração de sitemap XML, crawls salvos e comparação entre crawls.
- Agendamento de crawls, linha de comandos (CLI) e servidor MCP para assistentes de IA.
- Interface em português, inglês e espanhol; suporte a Windows, Linux e macOS.

[1.0.0]: https://github.com/PChiovatto/seo-spider/releases/tag/v1.0.0
