# Backlog rastreável

## Critérios

- **P0:** risco imediato de segurança, perda de dados ou bloqueio de tarefa crítica. Nenhum P0 de produto foi confirmado nesta auditoria estática/testada.
- **P1:** impede o objetivo de modernização, acessibilidade ou navegação por papel; deve ser resolvido antes do gate final da etapa responsável.
- **P2:** dívida relevante, mas com contorno existente ou menor impacto.

## P0

| Evidência | Rota / arquivo | Critério de aceite | Etapa |
| --- | --- | --- | --- |
| Nenhum P0 confirmado no seed `fe464e0df42ea6c7bd720c7ab000209a8cd54a67`. | — | Reclassificar imediatamente se browser E2E, auditoria anti-IDOR ou homologação encontrar perda de dados, bypass ou tarefa crítica impossível. | contínua |

## P1

| Evidência | Rota / arquivo | Critério de aceite | Etapa |
| --- | --- | --- | --- |
| A barra inferior é igual para todos os papéis; trabalho profissional entra por Configurações. | `/home`, `frontend/src/components/TabBar.jsx`, `frontend/src/views/Settings.jsx:1323` | Coach, Atleta e dual-role recebem mapa aprovado; módulos inativos somem; deep links antigos continuam. | 2 |
| `/coach` significa IA, enquanto `/coach/groups|challenges|programs` significa profissional humano. | `frontend/src/App.jsx:364`, `frontend/src/App.jsx:378` | Introduzir canonicalização sem colisão, aliases testados e nenhuma quebra de notificações/setup da IA. | 2 |
| Dual-role não tem modo global; Agenda e Comunidade mantêm switches locais e independentes. | `frontend/src/views/SchedulingView.jsx:1902`, `frontend/src/views/CommunityHub.jsx:29` | Alternância Coach/Aluno explícita, persistida e usada pelo shell, sem alterar autorização. | 2 |
| O switch de Comunidade usa `isCoach || user?.profile`, portanto perfil atleta comum também vê “Coach view”. | `frontend/src/views/CommunityHub.jsx:38` | Somente dual-role/profissional vê alternância; atleta comum não dispara endpoints Coach. | 2 |
| Lazy routes usam `Suspense fallback={null}`, permitindo quadro vazio sem anúncio. | `frontend/src/App.jsx:68` | Toda navegação lazy crítica mostra skeleton/status acessível e mantém foco/contexto. | 1 |
| 78 strings/atributos óbvios em inglês: 46 em Admin e 32 em AdminCoach. | `frontend/scripts/ux-audit-language-baseline.json`, `/admin` | Scanner chega a zero dívida não permitida em PT-BR; allowlist continua apenas técnica/brand/diagnóstico deliberado. | 5 |
| Views legadas críticas não têm landmark `<main>`; Plan e Stats têm saltos de heading estáticos. | `Home.jsx`, `Plan.jsx`, `Workout.jsx`, `Stats.jsx`, `Admin.jsx` | Um `main` por tela, headings sem saltos e teste automatizado + teclado manual. | 7 |
| Controles de Comunidade têm alvo CSS abaixo de 44 px (`gc-tab` 42 px; filtros sem mínimo; botões `sm` podem ficar menores). | `frontend/src/views/GroupChallenges.css:20`, `frontend/src/views/GroupChallenges.css:66`, `frontend/src/index.css:590` | Medição em 375/390/412 confirma todos os alvos interativos >=44×44 CSS px, sem sobreposição. | 1 e 6 |
| O build avisa chunks >1.500 kB; há imports dinâmicos ineficazes. | `npm run build --prefix frontend`, `frontend/src/lib/scan.js`, imports Capacitor | Comparativo raw/gzip, chunks críticos sob orçamento aprovado e warnings classificados/resolvidos sem regressão. | 6 |
| Não há browser instalado nem Playwright/Cypress no stack; screenshots 1440/768/375/412, overflow e console de rotas reais não foram medidos nesta máquina. | baseline desta etapa | Executar harness browser em ambiente provisionado, anexar screenshots por papel e registrar zero overflow/erros inesperados antes da Etapa 2. | 0 gate / 6 |
| Suíte frontend emite warning real de `<button>` dentro de `<button>` em Settings/Equipment. | `frontend/src/views/settings-pages.test.jsx`, componentes de Row/equipment | DOM sem controles interativos aninhados; teste não emite hydration warning. | 1 |
| Teste de progresso emite chave React duplicada `g_1`. | `frontend/src/views/ProgressAnalytics.test.jsx` | Lista usa chaves únicas em criação/edição e console fica limpo. | 3 ou 4 |

## P2

| Evidência | Rota / arquivo | Critério de aceite | Etapa |
| --- | --- | --- | --- |
| Catch-all redireciona rota desconhecida para Home sem explicar. | `frontend/src/App.jsx:383` | Estado 404/indisponível diferencia path inválido, módulo desligado e falta de permissão. | 5 |
| `/muscles` depende de `location.state.from` para acender Stats em vez de Biblioteca. | `frontend/src/components/TabBar.jsx:34` | Deep links têm parent determinístico e breadcrumb/retorno coerente. | 2 |
| Agenda e Comunidade existem como rotas próprias e embutidas no hub, duplicando entrada e estado. | `/professionals`, `/scheduling`, `/community` | Uma fonte de navegação por tarefa; embeds reutilizam estado sem requests duplicados. | 2–4 |
| Nutricionista herda labels e áreas de Coach, inclusive comunidade, só por `kind=coach`. | `api/b2b2c.js`, `ProfessionalHub.jsx`, `/coach/*` | Módulos respeitam especialidades; nomenclatura validada com usuários sem mudar políticas. | 2 e 8 |
| Views locais legadas não possuem estados error/retry explícitos porque leem `S`; falhas de sync ficam no banner global. | `/home`, `/plan`, `/stats`, `/library` | Cada tarefa crítica explica offline/sync e oferece retry quando houver operação remota. | 5 |
| Screenshots versionados são de 26/10/2026, v1.4.3, apenas 1170×2532 e cinco telas pessoais. | `assets/screenshots/*.png` | Baseline atual por papel em 1440/768/375/412, com seed e procedimento registrados. | 0 gate / 6 |
| Vários testes React emitem “not wrapped in act(...)”. | suíte frontend | Warnings classificados; testes alterados deixam de emitir ruído, preservando falhas de console úteis. | 7/9 |
| O script de bundle normaliza nomes hash e reporta 127 chaves estáveis para 172 artefatos JS/CSS/HTML; colisões de nomes podem ocultar detalhe por arquivo. | `frontend/scripts/bundle-size.mjs` | Relatório mantém total e identifica chunks homônimos sem sobrescrita. | 6 |
