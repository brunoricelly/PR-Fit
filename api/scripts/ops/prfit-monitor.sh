#!/usr/bin/env bash
# PR Fit watchdog (roda a cada 5 min). Alerta no Telegram so quando muda de estado (OK->PROBLEMA e
# PROBLEMA->OK) ou a cada 6h enquanto o problema persiste. Nunca imprime segredos.
# Checks: health publico (store=postgres, writable), containers healthy, PG responde, disco,
# erros recentes na API, idade do ultimo backup.
set -uo pipefail
ENV_FILE="${PRFIT_ENV_FILE:-/etc/prfit-monitor.env}"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
URL="${PRFIT_URL:-https://prfit.agentejh.tech}"
SVC="${PRFIT_SERVICE_UUID:-ntmqwqysdhi22zhqg2t3hv49}"
PG_CT="${PRFIT_PG_CONTAINER:-l8sda3wmdu9t65iphxhbwx0n}"
BK_DIR="${PRFIT_BACKUP_DIR:-/opt/pr-fit-backups/pg-daily}"
STATE="${PRFIT_STATE_FILE:-/var/lib/prfit-monitor.state}"
DISK_MAX="${PRFIT_DISK_MAX_PCT:-85}"
BK_MAX_H="${PRFIT_BACKUP_MAX_HOURS:-30}"
ERR_MAX="${PRFIT_ERR_MAX_5M:-20}"

problems=()
add() { problems+=("$1"); }

h="$(curl -fsS -m 10 "$URL/api/health" 2>/dev/null || true)"
if [ -z "$h" ]; then add "health publico sem resposta ($URL)"; else
  echo "$h" | grep -q '"ok":true' || add "health ok!=true"
  echo "$h" | grep -q '"writable":true' || add "health writable!=true"
  echo "$h" | grep -q '"store":"postgres"' || add "store nao e postgres"
fi
for c in "api-$SVC" "web-$SVC" "$PG_CT"; do
  st="$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}na{{end}}' "$c" 2>/dev/null || echo ausente)"
  case "$st" in running/healthy|running/na) ;; *) add "container $c: $st";; esac
done
docker exec "$PG_CT" sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1 || add "postgres nao aceita conexoes"
pct="$(df --output=pcent / | tail -1 | tr -dc 0-9)"
[ "${pct:-0}" -ge "$DISK_MAX" ] && add "disco / em ${pct}%"
errs="$(docker logs --since 5m "api-$SVC" 2>&1 | grep -ciE 'write failed|answering 500|writer lock|unhandled|ECONNREFUSED' || true)"
[ "${errs:-0}" -ge "$ERR_MAX" ] && add "$errs erros na API nos ultimos 5 min"
last="$(ls -1d "$BK_DIR"/2* 2>/dev/null | sort | tail -1 || true)"
if [ -z "$last" ]; then add "nenhum backup do PG encontrado"; else
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$last") ) / 3600 ))
  [ "$age_h" -ge "$BK_MAX_H" ] && add "ultimo backup tem ${age_h}h"
fi

now=$(date +%s)
prev_status="OK"; prev_ts=0
[ -f "$STATE" ] && read -r prev_status prev_ts < "$STATE" || true
msg=""
if [ "${#problems[@]}" -eq 0 ]; then
  [ "$prev_status" = "PROBLEMA" ] && msg="PR Fit RECUPERADO: tudo saudavel de novo."
  echo "OK $now" > "$STATE"
else
  body="$(printf -- '- %s\n' "${problems[@]}")"
  if [ "$prev_status" != "PROBLEMA" ] || [ $((now - prev_ts)) -ge 21600 ]; then
    msg="PR Fit PROBLEMA em $(hostname):
$body"
    echo "PROBLEMA $now" > "$STATE"
  else
    echo "PROBLEMA $prev_ts" > "$STATE"
  fi
fi
if [ -n "$msg" ]; then
  echo "$msg"
  if [ -n "${PRFIT_TG_TOKEN:-}" ] && [ -n "${PRFIT_TG_CHAT:-}" ]; then
    curl -fsS -m 15 -o /dev/null "https://api.telegram.org/bot${PRFIT_TG_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${PRFIT_TG_CHAT}" ${PRFIT_TG_THREAD:+--data-urlencode "message_thread_id=${PRFIT_TG_THREAD}"} \
      --data-urlencode "text=$msg" || echo "aviso: falha ao enviar Telegram" >&2
  fi
fi
[ "${#problems[@]}" -eq 0 ]
