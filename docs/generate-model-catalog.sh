#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: sh docs/generate-model-catalog.sh [BASE_URL [OUTPUT_FILE]]

Downloads a Codex model catalog from a running copilot-api gateway.
Requires curl and either Bun or Node.js.

Defaults:
  BASE_URL     COPILOT_API_BASE_URL or http://localhost:4141
  OUTPUT_FILE  $HOME/.codex/model_catalog.json

Set GITHUB_COPILOT_API_KEY if the gateway requires authentication.
Use the generated file's absolute path for model_catalog_json in config.toml.
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac
if [ "$#" -gt 2 ]; then
  usage >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  printf 'Error: curl is required. Install it and run the script again.\n' >&2
  exit 1
fi
if command -v bun >/dev/null 2>&1; then
  json_runtime=bun
elif command -v node >/dev/null 2>&1; then
  json_runtime=node
else
  printf 'Error: Bun or Node.js is required to validate the model catalog.\n' >&2
  exit 1
fi

base_url="${1:-${COPILOT_API_BASE_URL:-http://localhost:4141}}"
output_file="${2:-$HOME/.codex/model_catalog.json}"
case "$output_file" in
  /*) ;;
  *) output_file="./$output_file" ;;
esac
output_dir=$(dirname "$output_file")
mkdir -p "$output_dir"
if [ -d "$output_file" ]; then
  printf 'Error: output path is a directory: %s\n' "$output_file" >&2
  exit 1
fi
temp_file=$(mktemp "$output_dir/.model_catalog.json.XXXXXX")
trap 'rm -f "$temp_file"' 0
trap 'exit 1' HUP INT TERM

set -- --fail --silent --show-error --connect-timeout 10 --max-time 120 \
  --user-agent 'codex-tui/0.166.0 (Windows 10.0.26200; x86_64) vscode/1.139.1 (codex-tui; 0.166.0)' \
  --header 'originator: codex-tui' --header 'version: 0.166.0' \
  --header 'x-full-model-catalog: true' \
  --header 'Accept: application/json' --output "$temp_file"
if [ -n "${GITHUB_COPILOT_API_KEY:-}" ]; then
  set -- "$@" --header "Authorization: Bearer $GITHUB_COPILOT_API_KEY"
fi
if ! curl "$@" --url "${base_url%/}/models?client_version=0.166.0"; then
  printf 'Error: failed to download the model catalog. Check the gateway URL and API key.\n' >&2
  exit 1
fi

if ! "$json_runtime" -e '
  const { readFileSync } = require("node:fs")
  const catalog = JSON.parse(readFileSync(process.argv[1], "utf8"))
  const isModel = (model) => model !== null && typeof model === "object" &&
    !Array.isArray(model) && typeof model.slug === "string" && model.slug.length > 0
  if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog) ||
      !Array.isArray(catalog.models) || catalog.models.length === 0 ||
      !catalog.models.every(isModel)) {
    process.exit(1)
  }
' "$temp_file" >/dev/null 2>&1; then
  printf 'Error: response is not a non-empty Codex model catalog. The existing file was kept.\n' >&2
  exit 1
fi

mv -f "$temp_file" "$output_file"
printf 'Generated %s\n' "$output_file"
