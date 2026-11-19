# Store PostgreSQL

O backend PostgreSQL mantém o mesmo contrato do store JSON: o servidor trabalha com o documento em memória, persiste mudanças antes de responder com sucesso e conserva os documentos de estado por usuário separadamente.

## Configuração

Variáveis:

| Variável | Uso |
|---|---|
| `STORE=postgres` | Ativa o backend PostgreSQL. |
| `DATABASE_URL` | URL obrigatória (`postgres://usuario:senha@host:5432/database`). |
| `PG_POOL_MAX` | Máximo de conexões do pool; padrão 10, mínimo 1 e máximo 100. |
| `PG_SCHEMA_FROM_DATA_DIR=1` | Cria/usa um schema derivado de `DATA_DIR`. Destina-se a testes e instâncias isoladas. |
| `STORE_IMPORT_JSON=1` | Após migrations novas, importa `db.json` e `state-*.json` de `DATA_DIR` para banco vazio. |

Exemplo:

```bash
cd api
export STORE=postgres
export DATABASE_URL='postgres://app:senha@postgres:5432/prfit'
node server.js
```

As migrations em `api/migrations/` são executadas automaticamente na inicialização, em ordem e sob advisory lock. O runner recusa uma migration já aplicada cujo checksum tenha mudado. Não edite migrations aplicadas; crie a próxima migration numerada.

## Modelo de persistência

- `users`, `creds`, `coach_athlete_links` e `coach_invites` têm tabelas dedicadas e FKs.
- As outras coleções ficam em `collections`, por nome e chave de linha.
- Valores escalares e a lista de coleções presentes ficam em `meta`.
- `user_state` usa revisão otimista por usuário.
- `meta.$db_rev` é uma revisão global monotônica reservada ao store e não aparece no documento devolvido por `loadAll()`.

Cada transação de escrita do documento principal:

1. adquire `pg_advisory_xact_lock`;
2. lê `db_rev`;
3. se a revisão coincide com a última conhecida pelo pool, calcula o diff `base -> candidate` em memória e grava somente linhas alteradas;
4. se diverge, relê o documento sob o lock, faz o merge de três vias e acusa `ConcurrentDbWriteError` quando duas instâncias alteram a mesma chave superior;
5. incrementa `db_rev` e confirma a transação.

A fila serial do adaptador garante ordem dentro do processo. O advisory lock e `db_rev` protegem instâncias diferentes. Escritas independentes de várias réplicas preservam dados, mas a revisão global faz cada réplica que observou uma escrita externa usar uma reconciliação completa; portanto, o ganho principal é o fluxo normal de uma única réplica escritora.

## Migração de JSON para PostgreSQL

Faça backup antes do corte. Valide sem escrever:

```bash
cd api
node scripts/migrate-json-to-pg.js --data-dir /caminho/dados --dry-run
```

Importe para um banco vazio:

```bash
export DATABASE_URL='postgres://app:senha@postgres:5432/prfit'
node scripts/migrate-json-to-pg.js --data-dir /caminho/dados
```

Alternativamente, inicialize uma versão recém-migrada com `STORE_IMPORT_JSON=1` e o `DATA_DIR` legado. A importação automática só ocorre quando migrations foram aplicadas e o banco está vazio; depois retire a variável para evitar ambiguidade operacional.

Valide a aplicação com `STORE=postgres` antes de retirar o JSON de backup.

## Rollback/exportação

Exporte o estado PostgreSQL de volta ao formato de arquivos:

```bash
cd api
export DATABASE_URL='postgres://app:senha@postgres:5432/prfit'
node scripts/export-pg-to-json.js --out /caminho/rollback
```

O diretório recebe `db.json` e os `state-<uid>.json`. Pare escritores ou coloque a aplicação em manutenção durante o corte para que nenhum commit ocorra entre a exportação e a troca para `STORE=json`.

## Testes

Teste unitário/de integração do store:

```bash
cd api
DATABASE_URL='postgres://postgres:test@localhost:55432/postgres' \
  node --test test/store-diff.test.js test/store-pg.test.js
```

E2E B2B2C, em schema descartável:

```bash
STORE=postgres DATABASE_URL='postgres://postgres:test@localhost:55432/postgres' \
  npm run test:b2b2c
```

O script E2E deriva um schema do `DATA_DIR` e o remove no final. Consulte `scripts/bench-results.md` para metodologia e resultados de desempenho.

## Operação e diagnóstico

- Erro `meta db_rev ausente`: execute as migrations da versão atual antes de aceitar escrita.
- `ConcurrentDbWriteError`: outra instância alterou a mesma chave superior desde o estado-base; a transação é revertida e o adaptador relê o banco.
- Falha de migration por checksum: restaure o arquivo original e crie uma migration nova; não altere o registro manualmente.
- Monitore conexões do pool, latência de transação, espera no advisory lock e frequência do caminho lento entre réplicas.
- Faça backup PostgreSQL normal (`pg_dump`/snapshot) além da exportação JSON de rollback.
- Nunca compartilhe o mesmo database entre produção e benchmark. O benchmark cria e apaga databases `bench_*` e requer permissão para `CREATE DATABASE`/`DROP DATABASE`.
