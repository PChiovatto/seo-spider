# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/);
versao segundo [SemVer](https://semver.org/lang/pt-BR/).

## [1.0.0] - 2026-11-05

Primeira versao publica do SEO Spider: crawler de SEO tecnico que roda 100% local.

### Adicionado

- Rastreamento em modo Spider e modo Lista, com escopo por subdominio, subpasta ou todos os subdominios.
- Leitura e obediencia ao `robots.txt` (regras do Google, RFC 9309) e `Crawl-delay`, com testador de robots.txt.
- Sitemaps XML, filtros de inclusao/exclusao por regex e remocao de parametros (`utm_*`, `gclid`...).
- Renderizacao JavaScript com Chromium (Playwright), comparacao HTML bruto x renderizado e contorno de bloqueio de WAF.
- Autenticacao basica, login por formulario, cabecalhos e cookies customizados, proxy e User-Agent configuravel.
- Abas de analise no estilo Screaming Frog: Internos, Externos, Seguranca, Codigos de resposta, URL, Page Titles, Meta Description, H1, H2, Conteudo, Imagens, Canonicals, Paginacao, Hreflang, Dados estruturados, Links e outras.
- Painel de problemas (Issues, Warnings, Oportunidades), largura em pixels de titles/descriptions e pre-visualizacao SERP.
- Duplicados exatos e quase-duplicados (MinHash), similaridade semantica, cadeias de redirect e canonical, paginas orfas.
- Validacao de dados estruturados contra o vocabulario schema.org e auditoria de acessibilidade com axe-core.
- Ortografia e gramatica, n-gramas, link score e extracao customizada (CSS/XPath/regex) com inspetor visual.
- Visualizacoes: diagrama de links, arvore de diretorios, arvore de rastreamento, graficos e clusters de conteudo.
- Integracoes opcionais: Search Console, GA4, PageSpeed Insights, Majestic, Ahrefs, Moz e provedores de IA.
- Exportacao para Excel e CSV, relatorios, geracao de sitemap XML, crawls salvos e comparacao entre crawls.
- Agendamento de crawls, linha de comandos (CLI) e servidor MCP para assistentes de IA.
- Interface em portugues, ingles e espanhol; suporte a Windows, Linux e macOS.

[1.0.0]: https://github.com/PChiovatto/seo-spider/releases/tag/v1.0.0
