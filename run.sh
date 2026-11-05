#!/bin/sh
set -eu

cd -- "$(dirname -- "$0")"

if [ ! -d .venv ]; then
    python3 -m venv .venv
fi
. .venv/bin/activate

python -m pip install -q -r requirements.txt

url=http://127.0.0.1:8765
if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 &
fi

exec python -m uvicorn app:app --host 127.0.0.1 --port 8765
