# Changelog

[Português](CHANGELOG.md) · [English](CHANGELOG.en.md) · **Español**

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/);
versión según [SemVer](https://semver.org/lang/es/).

## [1.0.0] - 2026-11-05

Primera versión pública de SEO Spider: rastreador de SEO técnico que se ejecuta 100% local.

### Añadido

- Rastreo en modo Spider y modo Lista, con ámbito por subdominio, subcarpeta o todos los subdominios.
- Lectura y respeto de `robots.txt` (reglas de Google, RFC 9309) y `Crawl-delay`, con probador de robots.txt.
- Sitemaps XML, filtros de inclusión/exclusión por regex y eliminación de parámetros (`utm_*`, `gclid`…).
- Renderizado de JavaScript con Chromium (Playwright), comparación HTML bruto × renderizado y manejo de bloqueos de WAF.
- Autenticación básica, inicio de sesión por formulario, cabeceras y cookies personalizadas, proxy y User-Agent configurable.
- Pestañas de análisis al estilo Screaming Frog: Internos, Externos, Seguridad, Códigos de respuesta, URL, Page Titles, Meta Description, H1, H2, Contenido, Imágenes, Canonicals, Paginación, Hreflang, Datos estructurados, Enlaces y más.
- Panel de problemas (Issues, Warnings, Oportunidades), ancho en píxeles de titles/descriptions y vista previa del SERP.
- Duplicados exactos y casi duplicados (MinHash), similitud semántica, cadenas de redirección y canonical, páginas huérfanas.
- Validación de datos estructurados contra el vocabulario schema.org y auditoría de accesibilidad con axe-core.
- Ortografía y gramática, n-gramas, link score y extracción personalizada (CSS/XPath/regex) con inspector visual.
- Visualizaciones: diagrama de enlaces, árbol de directorios, árbol de rastreo, gráficos y clústeres de contenido.
- Integraciones opcionales: Search Console, GA4, PageSpeed Insights, Majestic, Ahrefs, Moz y proveedores de IA.
- Exportación a Excel y CSV, informes, generación de sitemap XML, rastreos guardados y comparación entre rastreos.
- Programación de rastreos, línea de comandos (CLI) y servidor MCP para asistentes de IA.
- Interfaz en portugués, inglés y español; soporte para Windows, Linux y macOS.

[1.0.0]: https://github.com/PChiovatto/seo-spider/releases/tag/v1.0.0
