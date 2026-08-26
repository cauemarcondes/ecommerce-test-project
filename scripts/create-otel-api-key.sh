#!/bin/sh
# Create (or reuse) an Elasticsearch API key for the EDOT Collector.
# https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-security-create-api-key
set -eu

SECRETS_FILE="${SECRETS_FILE:-/secrets/api_key}"
ENDPOINT="${ELASTIC_ENDPOINT:?ELASTIC_ENDPOINT is required}"
KEY_NAME="${ELASTIC_API_KEY_NAME:-mini-shop-otel-collector}"
USER="${ELASTIC_USERNAME:-elastic}"

mkdir -p "$(dirname "$SECRETS_FILE")"

wait_for_es() {
  echo "Waiting for Elasticsearch at ${ENDPOINT} ..."
  i=0
  while true; do
    code=$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 2 "${ENDPOINT}" || echo "000")
    case "$code" in
      200|401|403) return 0 ;;
    esac
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then
      echo "Elasticsearch was not reachable at ${ENDPOINT} after retries"
      exit 1
    fi
    sleep 2
  done
}

api_key_works() {
  key=$1
  [ -n "$key" ] || return 1
  code=$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 5 \
    -H "Authorization: ApiKey ${key}" \
    "${ENDPOINT}/_security/_authenticate" || echo "000")
  [ "$code" = "200" ]
}

write_key() {
  printf '%s' "$1" > "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
}

create_api_key() {
  if [ -z "${ELASTIC_PASSWORD:-}" ]; then
    echo "Existing API key is invalid and ELASTIC_PASSWORD is not set; cannot create a new key" >&2
    exit 1
  fi
  echo "Creating API key ${KEY_NAME} via POST /_security/api_key"
  RESP=$(curl -sf -u "${USER}:${ELASTIC_PASSWORD}" \
    -H "Content-Type: application/json" \
    -X POST "${ENDPOINT}/_security/api_key" \
    -d "{\"name\":\"${KEY_NAME}\",\"metadata\":{\"application\":\"mini-shop-otel\"}}")
  ENCODED=$(printf '%s' "$RESP" | sed -n 's/.*"encoded"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  if [ -z "$ENCODED" ]; then
    echo "Failed to parse encoded API key from response:"
    echo "$RESP"
    exit 1
  fi
  write_key "$ENCODED"
  echo "Created API key ${KEY_NAME}"
}

wait_for_es

CANDIDATE="${ELASTIC_API_KEY:-}"
if [ -z "$CANDIDATE" ] && [ -s "$SECRETS_FILE" ]; then
  CANDIDATE=$(tr -d '\n' < "$SECRETS_FILE")
  echo "Found stored API key at ${SECRETS_FILE}"
elif [ -n "$CANDIDATE" ]; then
  echo "Found ELASTIC_API_KEY in environment"
fi

if [ -n "$CANDIDATE" ] && api_key_works "$CANDIDATE"; then
  write_key "$CANDIDATE"
  echo "Existing API key is valid; reusing it"
  exit 0
fi

if [ -n "$CANDIDATE" ]; then
  echo "Existing API key failed authentication; creating a new one"
else
  echo "No existing API key; creating a new one"
fi

create_api_key
