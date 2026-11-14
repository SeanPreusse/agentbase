#!/bin/sh
set -eu

plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

run_with_node() {
  candidate=$1
  if [ -x "$candidate" ] && "$candidate" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22 || (major===22 && minor>=22) ? 0 : 1)' >/dev/null 2>&1; then
    exec "$candidate" "$plugin_root/bin/agentbase.mjs" serve
  fi
}

if [ -n "${AGENTBASE_NODE:-}" ]; then
  run_with_node "$AGENTBASE_NODE"
  echo 'AGENTBASE_NODE must point to Node.js 22.22 or newer.' >&2
  exit 1
fi

run_with_node "$plugin_root/runtime/node"
if command -v node >/dev/null 2>&1; then
  run_with_node "$(command -v node)"
fi
for candidate in "$HOME"/.nvm/versions/node/v*/bin/node "$HOME"/.volta/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
  run_with_node "$candidate"
done

echo 'AgentBase needs Node.js 22.22 or newer. Install Node or use the bundled Mac app.' >&2
exit 1
