#!/bin/bash
set -euo pipefail

if [[ -z "${ELASTIC_API_KEY:-}" && -f /secrets/api_key ]]; then
  export ELASTIC_API_KEY="$(tr -d '\n' < /secrets/api_key)"
fi

if [[ -z "${ELASTIC_API_KEY:-}" ]]; then
  echo "ELASTIC_API_KEY is not set and /secrets/api_key is missing" >&2
  exit 1
fi

exec /usr/bin/tini -- /usr/local/bin/docker-entrypoint --config /etc/otelcol-config.yml
