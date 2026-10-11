#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  printf '%s\n' 'OpenWork: missing MCP server entry point.' >&2
  exit 64
fi

# Use the runtime Codex actually supplies to its plugins. This does not bypass
# native peer authorization: the app still checks signing and real ancestry.
for candidate in \
  "${CODEX_MCP_NODE_PATH:-}" \
  "${CODEX_BROWSER_USE_NODE_PATH:-}" \
  "${CODEX_ELECTRON_RESOURCES_PATH:-}/cua_node/bin/node"
do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    exec "$candidate" "$@"
  fi
done

# External terminals can still use setup and diagnostics. Merely inheriting
# a pipe path is not native authorization; the host rejects untrusted peers.
if node_path=$(command -v node 2>/dev/null); then
  case "$node_path" in
    /*) exec "$node_path" "$@" ;;
  esac
fi

printf '%s\n' 'OpenWork could not find a Node runtime. Launch the plugin from Codex, or install Node 22+ for terminal setup.' >&2
exit 127
