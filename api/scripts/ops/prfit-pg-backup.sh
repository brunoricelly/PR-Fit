#!/usr/bin/env bash
# PR Fit: backup diario do PostgreSQL com prova de restore.
#   1. pg_dump (formato custom) do banco do container PG do Coolify
#   2. restaura o dump num banco temporario e compara contagem de linhas por tabela
#   3. SHA256 + retencao (14 dias, minimo 7 copias)
#   4. qualquer falha -> exit != 0 e aviso no Telegram (se PRFIT_TG_* estiver definido)
# Nunca imprime senha/URL. Uso: prfit-pg-backup.sh   (cron/systemd timer)
set -Eeuo pipefail
PG_CT="${PRFIT_PG_CONTAINER:-l8sda3wmdu9t65iphxhbwx0n}"
DEST="${PRFIT_BACKUP_DIR:-/opt/pr-fit-backups/pg-daily}"
KEEP_DAYS="${PRFIT_KEEP_DAYS:-14}"
KEEP_MIN="${PRFIT_KEEP_MIN:-7}"
ENV_FILE="${PRFIT_ENV_FILE:-/etc/prfit-monitor.env}"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/$TS"
TMPDB="restore_check_$TS"

notify() {
  [ -n "${PRFIT_TG_TOKEN:-}" ] && [ -n "${PRFIT_TG_CHAT:-}" ] || return 0
  curl -fsS -m 15 -o /dev/null "https://api.telegram.org/bot${PRFIT_TG_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${PRFIT_TG_CHAT}" ${PRFIT_TG_THREAD:+--data-urlencode "message_thread_id=${PRFIT_TG_THREAD}"} \
    --data-urlencode "text=$1" || true
}
fail() { echo "ERRO: $1" >&2; notify "PR Fit BACKUP FALHOU em $(hostname): $1"; docker exec "$PG_CT" sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -c 'DROP DATABASE IF EXISTS \"$TMPDB\"'" >/dev/null 2>&1 || true; exit 1; }
trap 'fail "linha $LINENO"' ERR

mkdir -p "$OUT"; chmod 700 "$DEST" "$OUT"
docker exec "$PG_CT" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$OUT/prfit.dump"
[ -s "$OUT/prfit.dump" ] || fail "dump vazio"

# prova de restore: banco temporario, mesmas contagens
docker exec "$PG_CT" sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE \"$TMPDB\"'" >/dev/null
docker exec -i "$PG_CT" sh -c "pg_restore -U \"\$POSTGRES_USER\" -d \"$TMPDB\" --no-owner" < "$OUT/prfit.dump" >/dev/null 2>"$OUT/restore.err" || true
COUNT_SQL="select string_agg(format('%s=%s', relname, n_live_tup), ',' order by relname) from pg_stat_user_tables"
rows_exact() { # contagem exata por tabela (n_live_tup e estimativa)
  docker exec "$PG_CT" sh -c "psql -U \"\$POSTGRES_USER\" -d \"$1\" -Atc \"select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1\"" |
  while read -r t; do printf '%s=%s\n' "$t" "$(docker exec "$PG_CT" sh -c "psql -U \"\$POSTGRES_USER\" -d \"$1\" -Atc 'select count(*) from public.\"$t\"'")"; done
}
rows_exact "$(docker exec "$PG_CT" sh -c 'echo "$POSTGRES_DB"')" > "$OUT/rows.src"
rows_exact "$TMPDB" > "$OUT/rows.restored"
docker exec "$PG_CT" sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -c 'DROP DATABASE \"$TMPDB\"'" >/dev/null
[ -s "$OUT/rows.src" ] || fail "nenhuma tabela lida no banco de origem"
# diferenca so e tolerada se for escrita real entre as duas leituras (origem pode ter crescido)
if ! diff -q "$OUT/rows.src" "$OUT/rows.restored" >/dev/null; then
  if ! awk -F= 'NR==FNR{s[$1]=$2;next} {if(!($1 in s)||$2>s[$1]) bad=1} END{exit bad}' "$OUT/rows.src" "$OUT/rows.restored"; then
    fail "restore tem mais linhas que a origem (inconsistente)"
  fi
  if ! awk -F= 'NR==FNR{r[$1]=$2;next} {if(!($1 in r)||r[$1]==0&&$2>0) bad=1} END{exit bad}' "$OUT/rows.restored" "$OUT/rows.src"; then
    fail "tabela vazia no restore mas com dados na origem"
  fi
fi
rm -f "$OUT/restore.err"
( cd "$OUT" && sha256sum prfit.dump rows.src rows.restored > SHA256SUMS && sha256sum -c SHA256SUMS >/dev/null )

# retencao: apaga > KEEP_DAYS mas sempre mantem as KEEP_MIN mais novas
mapfile -t ALL < <(ls -1d "$DEST"/2* 2>/dev/null | sort -r)
i=0
for d in "${ALL[@]}"; do
  i=$((i+1)); [ "$i" -le "$KEEP_MIN" ] && continue
  if [ -n "$(find "$d" -maxdepth 0 -mtime +"$KEEP_DAYS" 2>/dev/null)" ]; then rm -rf -- "$d"; fi
done
SIZE="$(du -h "$OUT/prfit.dump" | cut -f1)"
echo "OK $TS dump=$SIZE tabelas=$(wc -l < "$OUT/rows.src") restore=verificado"
