#!/bin/sh
set -eu

export HOST="${HOST:-0.0.0.0}"
export COPILOT_API_GITHUB_TOKEN="${COPILOT_API_GITHUB_TOKEN:-${GH_TOKEN:-}}"

data_home="${COPILOT_API_HOME:-}"
expect_home=false
check_home=true
for argument in "$@"; do
  if [ "$expect_home" = true ]; then
    data_home="$argument"
    expect_home=false
    continue
  fi
  case "$argument" in
    --api-home) expect_home=true ;;
    --api-home=*) data_home="${argument#--api-home=}" ;;
    --help|-h|--version) check_home=false ;;
  esac
done

if [ "$check_home" = true ] && [ -n "$data_home" ]; then
  if ! mkdir -p "$data_home" || [ ! -w "$data_home" ] || [ ! -x "$data_home" ]; then
    printf 'Cannot write API home: %s. Prepare the mounted directory for UID:GID %s:%s; see docs/docker.md. Do not use chmod 777.\n' "$data_home" "$(id -u)" "$(id -g)" >&2
    exit 1
  fi
  if [ -e "$data_home/config.json" ] && [ ! -r "$data_home/config.json" ]; then
    printf 'Cannot read %s/config.json. Back up existing data and correct ownership; refusing to replace it.\n' "$data_home" >&2
    exit 1
  fi
fi

if [ "$#" -gt 0 ] && [ "$1" = "--auth" ]; then
  shift
  exec bun --use-system-ca run dist/main.js auth "$@"
fi

if [ "$#" -gt 0 ] && [ "$1" = "auth" ]; then
  exec bun --use-system-ca run dist/main.js "$@"
fi

if [ "$#" -gt 0 ] && [ "$1" = "start" ]; then
  shift
fi

exec bun --use-system-ca run dist/main.js start --proxy-env "$@"
