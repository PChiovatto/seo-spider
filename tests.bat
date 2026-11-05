@echo off
rem SEO Spider — testes.
rem
rem   tests.bat             suite rapida (unit + falhas de rede)
rem   tests.bat -v          detalhado
rem   tests.bat full        suite + verificacao de regressao contra o baseline
rem   tests.bat baseline    regrava o baseline (requer rede)
rem
rem A verificacao de regressao faz um crawl real e por isso depende de rede.
cd /d "%~dp0"

if /i "%1"=="baseline" (
  ".venv\Scripts\python.exe" -m tests.baseline record --url https://example.com/ --max-urls 5
  exit /b %ERRORLEVEL%
)

if /i "%1"=="full" (
  ".venv\Scripts\python.exe" -m unittest discover -s tests
  if errorlevel 1 exit /b 1
  echo.
  echo == regressao ==
  ".venv\Scripts\python.exe" -m tests.baseline check
  exit /b %ERRORLEVEL%
)

".venv\Scripts\python.exe" -m unittest discover -s tests %*
exit /b %ERRORLEVEL%
