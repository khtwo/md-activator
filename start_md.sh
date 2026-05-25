#!/usr/bin/env sh
set -eu

# Launch MD Activator from POSIX shells such as sh or bash.
# Usage:
#   ./start.sh [content_root] [app options...]
#   ./start.sh --cd content_root [app options...]

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
CONTENT_ROOT=$(pwd)
DEFAULT_RELOAD=--reload

if [ "$#" -gt 0 ] && [ "${1#-}" = "$1" ]; then
  CONTENT_ROOT=$1
  shift
fi

for arg in "$@"; do
  case "$arg" in
    --reload | --no-reload)
      DEFAULT_RELOAD=
      ;;
  esac
done

UV_CACHE_DIR="${SCRIPT_DIR}/.uv-cache"
export UV_CACHE_DIR

if ! command -v uv >/dev/null 2>&1; then
  echo "uv was not found. Please install uv and run this launcher again." >&2
  exit 1
fi

cd "$SCRIPT_DIR"

echo "Checking Python dependencies..."
uv sync --quiet --native-tls

echo "Starting MD Activator ..."
exec uv run --no-sync --native-tls python -m app.main --cd "$CONTENT_ROOT" ${DEFAULT_RELOAD:+"$DEFAULT_RELOAD"} --no-use-colors "$@"
