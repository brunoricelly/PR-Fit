# Benchmark dos stores: JSON e PostgreSQL

Medição local em 19/11/2026, Node.js v22.22.2, Linux, 2 CPUs e 1.920 MB de RAM. O cenário adiciona uma mensagem por save. O PostgreSQL é o container `postgres:17-alpine`; cada execução cria e remove um database descartável. Comando-base:

```bash
DATABASE_URL=postgres://... node scripts/bench-store.js \
  --backends postgres --users <N> --records <N> --saves 100 \
  --phase-budget 150 --writers 4 --duration 20 --out <arquivo.json>
```

## Save de uma mensagem — PostgreSQL antes/depois

| Registros pedidos | Antes n | Antes p50 | Antes p95 | Depois n | Depois p50 | Depois p95 | Redução p50 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 20.000 | 65 | 2.104,25 ms | 2.445,68 ms | 100 | 130,41 ms | 181,20 ms | 93,8% (16,1x) |
| 50.000 | 25 | 5.280,67 ms | 6.193,23 ms | 100 | 291,42 ms | 326,00 ms | 94,5% (18,1x) |
| 100.000 | 9 | 16.259,38 ms | 19.354,63 ms | 82¹ | 596,91 ms | 660,84 ms | 96,3% (27,2x) |
| 200.000 | —² | — | — | 26¹ | 1.433,63 ms | 1.884,03 ms | — |

¹ O orçamento de 150 s da fase foi atingido; os percentis usam todos os saves concluídos.  
² A execução anterior de 200 mil não produziu resultado PostgreSQL por falha de autenticação do container.

O caminho normal não lê mais todas as tabelas dentro da transação. Sob o advisory lock, ele lê somente `db_rev`, calcula/aplica o diff entre o estado conhecido pelo processo e o candidato e incrementa a revisão. Se outra instância mudou a revisão, usa o caminho de reconciliação completo e mantém a detecção de conflito.

## Comparação com JSON já medido

| Registros pedidos | JSON n | JSON p50 save | PostgreSQL depois n | PostgreSQL depois p50 |
|---:|---:|---:|---:|---:|
| 20.000 | 121¹ | 1.042,77 ms | 100 | 130,41 ms |
| 50.000 | 38¹ | 3.362,49 ms | 100 | 291,42 ms |
| 100.000 | 0³ | — | 82¹ | 596,91 ms |
| 200.000 | —⁴ | — | 26¹ | 1.433,63 ms |

³ O guard de disco recusou o save JSON de 100 mil antes da medição.  
⁴ JSON em 200 mil não foi repetido: inviável no disco disponível, conforme planejado.

## Quatro writers

Cada processo escreve em uma coleção distinta por 20 s. Como toda escrita externa muda `db_rev`, writers independentes alternam para o caminho lento de reconciliação; esta medição é deliberadamente o pior caso entre réplicas.

| Registros pedidos | Antes saves/s | Depois saves/s | Saves depois | Erros depois |
|---:|---:|---:|---:|---:|
| 20.000 | 1,00 | 1,60 | 32 | 0 |
| 50.000 | 0,50 | 0,65 | 13 | 0 |
| 100.000 | 0,35 | 0,40 | 8 | 0 |
| 200.000 | — | 0,30 | 6 | 0 |

## Observações de leitura

- `--records` controla os registros sintéticos principais; o total efetivo inclui usuários, credenciais e vínculos (20.664, 51.659, 103.294 e 206.582 linhas).
- Os resultados “antes” vieram dos arquivos reais `benchout/r_*.json`; os resultados “depois”, de `benchnew/r_*.json`.
- Percentis não são projeções. Células ausentes refletem fases realmente não executadas ou abortadas.
- A melhora principal é no save de uma única instância. Escalar escrita concorrente entre réplicas exige uma estratégia adicional de revisão por coleção/chave, em vez de uma revisão global.
