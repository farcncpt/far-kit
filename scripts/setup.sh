#!/usr/bin/env bash
# far-kit setup — installs runtime deps for every bundled MCP server.
# Run from anywhere: bash scripts/setup.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== far-kit setup =="
for dir in \
  "$ROOT/servers/truth-seeker" \
  "$ROOT/servers/internal-code" \
  "$ROOT/servers/refactor-runtime" \
  "$ROOT/servers/field-trip" \
  "$ROOT/servers/field-trip/mcp-server"; do
  if [ -f "$dir/package.json" ]; then
    echo "-- npm install: ${dir#$ROOT/}"
    (cd "$dir" && npm install --omit=dev --no-audit --no-fund --loglevel=error)
  fi
done

# Rust binary needs the exec bit after a git clone on unix
chmod +x "$ROOT/servers/refactor-runtime/bin/refactor-runtime" 2>/dev/null || true

echo ""
echo "Done. Next steps:"
echo "  1. Load the Chrome extension: chrome://extensions -> Developer mode -> Load unpacked -> servers/field-trip/extension"
echo "  2. Start the relay:           node servers/field-trip/cli/ws-relay.mjs   (port 9333)"
echo "  3. Tab ownership panel:       http://localhost:9333/"
echo "  4. Install the plugin:        /plugin marketplace add <this repo> ; /plugin install far-kit@far-kit"
