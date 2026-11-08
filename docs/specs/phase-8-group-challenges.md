# PR Fit — Fase 8: Programas Coletivos e Desafios (1 para N)

## Especificação Full-Stack e Definition of Done

### Fonte e escopo
Esta especificação consolida toda a Fase 8. O backend entregue no Checkpoint 1 é apenas a fundação; a fase só pode ser declarada concluída após contratos, frontend, integração, segurança, testes, deploy e E2E abaixo.

## A. Persistência e domínio (Schema v9)
- Coleções duráveis: `coachGroups`, `groupMembers`, `challenges`, `challengeScores`, `challengeActivityFeed`.
- Migração v8→v9 determinística e fail-closed; restart preserva grupos, membros, desafios, scores e feed.
- Integridade referencial estrita entre coach, atleta, vínculo, grupo, desafio, score e atividade.
- Exclusão de conta reconciliada e atômica para coach e atleta.
- Quotas globais, por coach/grupo/desafio e retenção de feed; nenhuma estrutura cresce sem limite.
- Escritas concorrentes usam o coordenador persistente existente e não perdem alterações entre processos.

## B. Backend e autorização
### Grupos
- Coach: criar, listar paginado, detalhar, editar com concorrência otimista, arquivar/excluir, adicionar/remover membros, rotacionar/revogar convite.
- Atleta: listar grupos, entrar por código, sair e consultar detalhe permitido.
- `maxMembers` deve ser atômico sob concorrência; nunca exceder o limite.
- Convites privados não vazam em listagens/respostas destinadas ao atleta; códigos fortes, únicos e rotacionáveis.
- Coach só gerencia atletas com vínculo ativo e escopo elegível; anti-IDOR entre tenants.

### Desafios e programas coletivos
- CRUD coach com lifecycle explícito: `draft`, `active`, `ended/archived` e transições válidas.
- Escopo `group` ou `coach_students`; elegibilidade é congelada ou definida explicitamente para evitar mudança retroativa silenciosa.
- Tipos: `workouts_count`, `habits_consistency`, `volume_load`, `custom_points`.
- Pontuação vem das fontes reais das Fases 2/5 e do histórico de treino; não confiar em valor arbitrário do cliente.
- `custom_points` exige endpoint autorizado/auditável, razão obrigatória, idempotency key e limites; se não for implementado, tipo deve permanecer indisponível.
- Leaderboard determinístico, empates documentados, privacidade de nomes e paginação.
- Activity feed imutável, paginado, sem notas ou PII desnecessária.

### Contrato
- OpenAPI 3.1 cobre 100% das rotas registradas, schemas, paginação, lifecycle, erros e exemplos.
- Erros estáveis para 400/401/403/404/409/410/422/429/503.
- Scanner de paridade deve inspecionar `challenges.js`.
- Documentação HTML regenerada e sincronizada.

## C. Cliente frontend
Criar `frontend/src/lib/group-challenges-api.js` com métodos tipados/documentados para todas as superfícies coach e atleta, AbortSignal, paginação/cursor e tratamento padronizado de erros.

## D. UI Coach
Integrar no Hub Profissional uma seção **Grupos e Desafios** com:
- Lista de grupos: busca, paginação, estados loading/empty/error/retry.
- Criar/editar grupo: nome, descrição, categoria, privacidade, capacidade.
- Detalhe do grupo: membros, capacidade, adicionar/remover, código de convite mascarado, copiar, rotacionar/revogar.
- Lista e detalhe de desafios: criar/editar rascunho, publicar/ativar, encerrar/arquivar.
- Configuração do tipo, período, timezone, escopo, regras/pontos e critérios.
- Leaderboard e feed recentes atualizáveis, com estados vazios e privacidade.
- Confirmações para ações destrutivas, prevenção de duplo envio e tratamento de conflito 409.

## E. UI Atleta
- Entrada visível em navegação/configurações para **Meus grupos e desafios**.
- Entrar por código; listar grupos; sair com confirmação.
- Listar desafios elegíveis/ativos/encerrados.
- Detalhe com regras, período/timezone, progresso próprio, ranking e feed permitido.
- Estados loading/empty/error/retry/offline; respostas claras para convite inválido/expirado, lotação, remoção e desafio encerrado.

## F. UX, acessibilidade e privacidade
- Componentes responsivos para mobile e desktop; teclado completo, foco inicial/restaurado e modais com focus trap.
- Labels acessíveis, `aria-live` para mutações e erros, contraste adequado.
- Datas exibidas no timezone do desafio, sem depender do timezone local do navegador.
- Nenhuma nota privada, e-mail, ID interno ou inviteCode exposto indevidamente.
- Dual-role permite alternar coach/atleta quando aplicável.

## G. Testes obrigatórios
### Backend
- CRUD/lifecycle, autorização, anti-IDOR, vínculos e escopos.
- Concorrência real multiprocesso para capacidade e writes conflitantes.
- Migração/restart/persistência/fail-closed/account teardown.
- Pontuação real para cada tipo, idempotência, desempate, paginação e privacidade.
- Quotas, rate limit e erros estáveis.

### Frontend
- Cliente API: paths, payloads, query/cursor, erros e AbortSignal.
- Coach: CRUD grupo, membros, convite, desafio/lifecycle, ranking/feed.
- Atleta: join/leave, listas, detalhe/progresso/ranking.
- Dual-role, timezone, corridas de requisição, duplo submit, acessibilidade e navegação.
- Suíte completa e build Vite.

### Cross-layer e release
- API completa, frontend completo, OpenAPI/paridade/docs e `git diff --check`.
- Docker API/Web a partir do SHA final.
- Probes anti-IDOR, concorrência, schema v9, restart, idempotência e rollback compatível com snapshot.
- E2E autenticado real: coach cria grupo/desafio e adiciona atleta; atleta entra, visualiza desafio/ranking e sai; coach encerra desafio.
- Limpeza das fixtures E2E comprovada.
- Duas auditorias finais sem P0/P1.
- JEV canônico uma vez, somente após todos os gates, com limiar 0,74.

## H. Checkpoints de implementação
1. Backend/persistência/motor (em auditoria).
2. Remediações críticas e concorrência real.
3. OpenAPI final + cliente frontend.
4. UI Coach.
5. UI Atleta + dual-role + integração de navegação.
6. Auditoria final, builds, E2E, JEV, PR, merge e deploy.
