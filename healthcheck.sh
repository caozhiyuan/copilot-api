#!/bin/sh
set -eu

url_file="${COPILOT_API_HEALTHCHECK_FILE:-/tmp/copilot-api/healthcheck-url}"
[ -r "$url_file" ] || exit 1
IFS= read -r url < "$url_file"

case "$url" in
  http://*|https://*) ;;
  *) exit 1 ;;
esac

exec curl --noproxy '*' --connect-timeout 2 --max-time 4 -fsS "$url" >/dev/null
