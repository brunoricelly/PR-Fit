# PR Fit ops (VPS John)
- `prfit-pg-backup.sh`: dump diario do PG + restore de prova num banco temporario + retencao 14d/min 7.
- `prfit-monitor.sh`: watchdog a cada 5 min (health, containers, PG, disco, erros, idade do backup).
- Config opcional em `/etc/prfit-monitor.env` (modo 600): `PRFIT_TG_TOKEN`, `PRFIT_TG_CHAT`, `PRFIT_TG_THREAD`.
  Sem esse arquivo os scripts funcionam e so registram no journal (sem aviso no Telegram).
- Instalar: copiar para `/opt/prfit-ops/` e criar timers (`prfit-backup.timer` 03:10 UTC, `prfit-monitor.timer` 5 min).
- Restore manual: `docker exec -i <pg> pg_restore -U <user> -d <db> --clean --if-exists < prfit.dump`.
