# E2E B2B2C (coach ↔ aluno)

Scripts Python (`requests`) que exercitam a API B2B2C contra um servidor real. Cada script imprime `PASS`/`FAIL` por assert e termina com
`SUMMARY <nome> <n> PASS, <m> FAIL` (exit code 1 se houver FAIL).

| Script | Cobre |
|---|---|
| `1_invites_scopes.py` | convites, escopos por especialidade, quem lê o quê |
| `2_prescriptions_consent.py` | prescrição, validação de payload, consentimento, suspender/encerrar/re-vincular, limite de convites |
| `3_concurrency_delete.py before\|after` | aceites concorrentes, exclusão de conta de aluno, persistência após restart |
| `4_race_account_delete.py before\|after` | corrida no mesmo convite, resíduos após excluir aluno (lido direto do store), restart |

Rode pelo runner, que sobe uma API descartável (DATA_DIR temporário novo, porta 3999), reinicia o servidor entre `before` e `after` e apaga tudo:

```sh
npm run test:b2b2c                                   # STORE=json (padrão)
STORE=postgres DATABASE_URL=postgres://… npm run test:b2b2c   # schema próprio por execução (PG_SCHEMA_FROM_DATA_DIR=1), apagado no fim
```

Variáveis: `STORE`, `DATABASE_URL`, `PORT`, `PYTHON`. Requer `python3` com `requests` e `curl`. Os scripts dependem da ordem 1→2→3→4 (mesmo banco).
