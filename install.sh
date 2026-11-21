#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

resolve_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  local candidates=(
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "$HOME/.volta/bin/node"
    "$HOME/.asdf/shims/node"
    "$HOME/.local/share/mise/shims/node"
    "$HOME/.nodenv/shims/node"
    "$HOME/.fnm/aliases/default/bin/node"
    "$HOME/.local/bin/node"
  )

  for bin in "${candidates[@]}"; do
    if [ -x "$bin" ]; then
      printf '%s\n' "$bin"
      return 0
    fi
  done

  if [ -d "$HOME/.nvm/versions/node" ]; then
    local nvm_node=""
    while IFS= read -r candidate; do
      if [ -x "$candidate" ]; then
        nvm_node="$candidate"
      fi
    done < <(find "$HOME/.nvm/versions/node" -maxdepth 3 -path "*/bin/node" 2>/dev/null | sort -V)
    if [ -n "$nvm_node" ]; then
      printf '%s\n' "$nvm_node"
      return 0
    fi
  fi

  return 1
}

if ! NODE_BIN="$(resolve_node)"; then
  echo "Error: Node.js (v18+) was not found in PATH or common macOS/Linux locations." >&2
  echo "Please install Node.js first (e.g. 'brew install node' or https://nodejs.org/) and re-run." >&2
  exit 1
fi

export PATH="$(dirname "$NODE_BIN"):$PATH"
exec "$NODE_BIN" "$SCRIPT_DIR/install.mjs" "$@"
