#!/usr/bin/env bash
# Installs the agent-net terminal-agent mesh on this machine:
#   1. Copies agent-net.mjs to ~/.claude/agent-net/
#   2. Merges the four lifecycle hooks + the messaging permission rule into
#      ~/.claude/settings.json (idempotent — existing settings preserved)
# After install, every NEW Claude Code session auto-registers on the mesh.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/.claude/agent-net"
SETTINGS="$HOME/.claude/settings.json"

mkdir -p "$DEST"
cp "$ROOT/agent-net/agent-net.mjs" "$DEST/"
echo "installed $DEST/agent-net.mjs"

node - "$SETTINGS" "$DEST/agent-net.mjs" <<'EOF'
const fs = require("fs");
const [settingsPath, scriptPath] = process.argv.slice(2);
const s = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};

s.hooks = s.hooks || {};
for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]) {
  const cmd = `node ${scriptPath} hook ${ev}`;
  s.hooks[ev] = s.hooks[ev] || [];
  const exists = s.hooks[ev].some((e) => (e.hooks || []).some((h) => h.command === cmd));
  if (!exists) s.hooks[ev].push({ hooks: [{ type: "command", command: cmd, timeout: 10 }] });
}

s.permissions = s.permissions || {};
s.permissions.allow = s.permissions.allow || [];
const rule = `Bash(node ${scriptPath} *)`;
if (!s.permissions.allow.includes(rule)) s.permissions.allow.push(rule);

fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
console.log("hooks + permission rule merged into", settingsPath);
EOF

echo ""
echo "Done. New Claude Code sessions auto-register on the mesh."
echo "Try: node $DEST/agent-net.mjs list"
echo "Note: 'spawn' and 'rc-rescue' need Windows Terminal (wt.exe) — WSL/Windows only."
