# Como contribuir

**Português** · [English](#english) · [Español](#español)

Obrigado pelo interesse em melhorar o SEO Spider! Toda ajuda é bem-vinda: correção de bugs, novas
verificações de SEO, traduções, documentação ou só reportar um problema.

## Reportar um bug ou sugerir uma ideia
Abra uma [issue](https://github.com/PChiovatto/seo-spider/issues/new/choose) usando o modelo correspondente. Para bugs, inclua a URL
(ou um site de exemplo público), os passos para reproduzir e o que você esperava ver.

## Preparar o ambiente
```bash
git clone https://github.com/PChiovatto/seo-spider.git
cd seo-spider
python -m venv .venv
.venv\Scripts\activate            # Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium
python -m uvicorn app:app --host 127.0.0.1 --port 8765 --reload
```

## Enviar uma mudança (pull request)
1. Faça um *fork* do repositório e crie um branch: `git checkout -b minha-melhoria`.
2. Faça a mudança. Mantenha o estilo do código existente e PRs pequenos e focados em um assunto.
3. Rode os testes: `python -m unittest discover -s tests` (ou `tests.bat` no Windows).
4. Se criar uma métrica nova, adicione um teste que prove que ela **varia** quando os dados mudam
   e **não varia** quando são iguais (veja [tests/README.md](tests/README.md)).
5. Se adicionar texto na interface, inclua as traduções em inglês e espanhol em `static/i18n.json`.
6. Abra o pull request descrevendo o que mudou e por quê.

## Regras importantes
- **Nunca** inclua chaves de API, tokens ou arquivos da pasta `data/` em commits.
- Não adicione dependências novas sem necessidade; explique no PR quando forem precisas.
- Use apenas sites públicos de teste (como `books.toscrape.com` ou `example.com`) em testes e exemplos.
- Seja respeitoso nas discussões.

Ao contribuir, você concorda que sua contribuição será licenciada sob a [Licença MIT](LICENSE).

---

## English

Thanks for your interest in improving SEO Spider! Bug fixes, new SEO checks, translations,
documentation and bug reports are all welcome.

- **Bugs and ideas:** open an [issue](https://github.com/PChiovatto/seo-spider/issues/new/choose) using the matching template.
- **Setup:** see the commands in the Portuguese section above (clone, venv, `pip install -r requirements.txt`, `python -m playwright install chromium`, run with uvicorn).
- **Pull requests:** fork, create a branch, keep PRs small and focused, run `python -m unittest discover -s tests`, and describe what changed and why.
- New metrics need a test proving they **vary** when data changes and **don't vary** when it doesn't.
- New UI text needs English and Spanish translations in `static/i18n.json`.
- **Never** commit API keys, tokens or anything from the `data/` folder.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).

---

## Español

¡Gracias por tu interés en mejorar SEO Spider! Son bienvenidas correcciones de errores, nuevas
verificaciones SEO, traducciones, documentación y reportes de problemas.

- **Errores e ideas:** abre un [issue](https://github.com/PChiovatto/seo-spider/issues/new/choose) con la plantilla correspondiente.
- **Entorno:** consulta los comandos de la sección en portugués (clonar, venv, `pip install -r requirements.txt`, `python -m playwright install chromium`, ejecutar con uvicorn).
- **Pull requests:** haz un fork, crea una rama, mantén los PR pequeños y enfocados, ejecuta `python -m unittest discover -s tests` y describe qué cambió y por qué.
- Las métricas nuevas necesitan una prueba que demuestre que **varían** cuando cambian los datos y **no varían** cuando son iguales.
- Los textos nuevos de la interfaz necesitan traducción al inglés y al español en `static/i18n.json`.
- **Nunca** subas claves de API, tokens ni nada de la carpeta `data/`.

Al contribuir, aceptas que tu contribución se licencia bajo la [Licencia MIT](LICENSE).
