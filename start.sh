#!/usr/bin/env bash
# FreeTrain – start script
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$DIR/.venv"
REQS="$DIR/server/requirements.txt"

echo ""
echo "  ╔══════════════════════════════╗"
echo "  ║        FreeTrain  🚲         ║"
echo "  ╚══════════════════════════════╝"
echo ""

# Create venv if missing
if [ ! -d "$VENV" ]; then
  echo "  Setting up Python environment..."
  python3 -m venv "$VENV"
  echo "  Installing dependencies..."
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r "$REQS"
  echo "  Done."
  echo ""
fi

# Re-install if requirements changed
"$VENV/bin/pip" install --quiet -r "$REQS" --upgrade 2>/dev/null || true

# Load .env if it exists
if [ -f "$DIR/.env" ]; then
  set -a
  source "$DIR/.env"
  set +a
fi

echo "  Starting server at http://localhost:8765"
echo "  Press Ctrl+C to stop."
echo ""

cd "$DIR/server"
exec "$VENV/bin/python" main.py
