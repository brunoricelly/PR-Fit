#!/usr/bin/env bash
# E2E B2B2C (coach <-> aluno) contra uma API descartavel.
#   STORE=json|postgres  (padrao json)        PORT=3999 (padrao)
#   DATABASE_URL         obrigatoria com STORE=postgres (schema proprio por DATA_DIR: PG_SCHEMA_FROM_DATA_DIR=1)
# DATA_DIR e temporario e novo a cada execucao; o servidor e parado pelo PID exato e os dados apagados.
# Exit code != 0 se algum assert falhar (ou o servidor nao subir).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="$(cd "$HERE/.." && pwd)"
E2E="$API/test/e2e-b2b2c"
STORE="${STORE:-json}"
PORT="${PORT:-3999}"
PY="${PYTHON:-python3}"
if [ "$STORE" = postgres ] && [ -z "${DATABASE_URL:-}" ]; then echo "STORE=postgres exige DATABASE_URL" >&2; exit 2; fi
"$PY" -c 'import requests' 2>/dev/null || { echo "python3 com o modulo requests e necessario" >&2; exit 2; }

DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/b2b2c-e2e-XXXXXX")"
LOG="$DATA_DIR.log"
PID=""
cleanup() {
  [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; }
  if [ "$STORE" = postgres ]; then  # drop the schema this run created
    ( cd "$API" && DATA_DIR="$DATA_DIR" node --input-type=module -e "
      import pg from 'pg'; import { schemaForDataDir } from './store/index.js';
      const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
      await c.query('DROP SCHEMA IF EXISTS ' + schemaForDataDir(process.env.DATA_DIR) + ' CASCADE'); await c.end();" ) >/dev/null 2>&1 || echo "aviso: nao consegui apagar o schema do PG" >&2
  fi
  rm -rf "$DATA_DIR" "$LOG"
}
trap cleanup EXIT

start_server() {
  ( cd "$API" && exec env STORE="$STORE" DATA_DIR="$DATA_DIR" PORT="$PORT" ORIGIN="http://localhost:$PORT" RP_ID=localhost RP_NAME=test \
      PASSWORD_LOGIN=1 FIRST_USER_ADMIN=1 INVITE_ONLY=0 TRUST_PROXY=0 PG_SCHEMA_FROM_DATA_DIR=1 \
      node server.js >>"$LOG" 2>&1 ) &
  PID=$!
  for _ in $(seq 1 150); do
    curl -fs "http://localhost:$PORT/api/health" >/dev/null 2>&1 && return 0
    kill -0 "$PID" 2>/dev/null || { echo "servidor morreu ao subir:" >&2; tail -20 "$LOG" >&2; return 1; }
    sleep 0.2
  done
  echo "timeout aguardando /api/health" >&2; tail -20 "$LOG" >&2; return 1
}
stop_server() { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; PID=""; }

export B2B_BASE="http://localhost:$PORT" E2E_TMP="$DATA_DIR.e2e" DATA_DIR STORE DATABASE_URL PG_SCHEMA_FROM_DATA_DIR=1
mkdir -p "$E2E_TMP"; trap 'cleanup; rm -rf "$E2E_TMP"' EXIT
start_server || exit 1
echo "== e2e b2b2c  STORE=$STORE  PORT=$PORT  DATA_DIR=$DATA_DIR =="
curl -s "$B2B_BASE/api/health"; echo

fail=0; tp=0; tf=0
run() { # nome, script, args...
  local name="$1"; shift
  local out; out="$(cd "$E2E" && "$PY" "$@" 2>&1)"; local rc=$?
  printf "%s\n" "$out" | grep -E '^(FAIL|SUMMARY)|Traceback|Error' | sed "s/^/[$name] /"
  local line; line="$(printf "%s\n" "$out" | grep '^SUMMARY' | tail -1)"
  [ -z "$line" ] && { echo "[$name] sem SUMMARY (script quebrou)"; echo "$out" | tail -15; fail=1; }
  [ $rc -ne 0 ] && fail=1
  tp=$((tp + $(sed -n 's/.* \([0-9]*\) PASS, .*/\1/p' <<<"$line" | head -1 | sed 's/^$/0/')))
  tf=$((tf + $(sed -n 's/.*PASS, \([0-9]*\) FAIL.*/\1/p' <<<"$line" | head -1 | sed 's/^$/0/')))
}
run 1-vinculos 1_invites_scopes.py
run 2-prescricao 2_prescriptions_consent.py
run 3-concorrencia 3_concurrency_delete.py before
run 4-corrida-exclusao 4_race_account_delete.py before
echo "-- reiniciando o servidor (mesmo DATA_DIR/schema) --"
stop_server; start_server || exit 1
run 3-persistencia 3_concurrency_delete.py after
run 4-persistencia 4_race_account_delete.py after
echo "TOTAL: $tp PASS, $tf FAIL"
if [ $fail -eq 0 ]; then echo "E2E B2B2C OK (STORE=$STORE)"; else echo "E2E B2B2C FALHOU (STORE=$STORE)"; fi
exit $fail
