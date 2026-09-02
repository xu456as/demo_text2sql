#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

if ! command -v python3 >/dev/null || ! command -v npm >/dev/null; then
  echo "需要 Python 3.11+ 和 Node.js 20+"
  exit 1
fi

cleanup() {
  kill "${BACKEND_PID:-}" "${FRONTEND_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
VENV_DIR="$ROOT_DIR/backend/.venv"
source "$VENV_DIR/bin/activate"
## TODO: load the .venv python environment if it exists
(cd "$ROOT_DIR/backend" && python3 -m uvicorn app.main:app --reload --port 8000) &
BACKEND_PID=$!
(cd "$ROOT_DIR/frontend" && npm run dev -- --host 127.0.0.1) &
FRONTEND_PID=$!

echo "DataChat API: http://127.0.0.1:8000/docs"
echo "DataChat UI:  http://127.0.0.1:5173"
wait
