# Inventário de rotas

## Método

O bloco tabular abaixo é gerado por `frontend/scripts/ux-audit.mjs` diretamente de `frontend/src/App.jsx`, dos imports eager/lazy e das referências de navegação encontradas em `frontend/src/`. Assim, a auditoria não cria um segundo contrato de rotas. Rode `npm run audit:ux --prefix frontend` para detectar divergência ou `node frontend/scripts/ux-audit.mjs --write-route-doc` após uma alteração intencional no router.

Todas as rotas de view passam primeiro pelo shell global: sem conta ou modo local, qualquer caminho exibe `Login`; onboarding mobile e permissões também interceptam o conteúdo antes de `Routes`. “Conta ou modo local” não equivale a autorização de API: operações profissionais continuam sujeitas às políticas do backend.

## Rotas declaradas

<!-- ux-audit:routes:start -->
| Rota | Ator permitido | Origem na navegação | Módulo | View / destino | Carga | Proteção observada |
| --- | --- | --- | --- | --- | --- | --- |
| `/home` | Atleta, profissional, dual-role e admin | tab bar, Tour, tour guiado, sheets, CheckIn | — | `Home` | lazy | shell: conta ou modo local |
| `/checkin` | Atleta, profissional, dual-role e admin | Nfc, Home, AthleteToday | `checkin` | `CheckIn` | lazy | shell: conta ou modo local; módulo `checkin` |
| `/plan` | Atleta, profissional, dual-role e admin | RoutineShare, tab bar, Tour, tour guiado, sheets | — | `Plan` | lazy | shell: conta ou modo local |
| `/plan/r/:id` | Atleta, profissional, dual-role e admin | RoutineShare, Tour, tour guiado, sheets, Plan | — | `RoutineEdit` | lazy | shell: conta ou modo local |
| `/plan/programmes` | Atleta, profissional, dual-role e admin | Home, Plan, Programmes | — | `Programmes` | lazy | shell: conta ou modo local |
| `/plan/prog/:id` | Atleta, profissional, dual-role e admin | Programmes | — | `ProgrammeEdit` | lazy | shell: conta ou modo local |
| `/workout` | Atleta, profissional, dual-role e admin | tab bar, Tour, nav, tour guiado, sheets | — | `Workout` | lazy | shell: conta ou modo local |
| `/stats` | Atleta, profissional, dual-role e admin | tab bar, tour guiado, widget-links, History, Home | — | `Stats` | lazy | shell: conta ou modo local |
| `/history` | Atleta, profissional, dual-role e admin | tour guiado, sheets, Stats, AthleteToday | — | `History` | lazy | shell: conta ou modo local |
| `/library` | Atleta, profissional, dual-role e admin | tab bar, scroll-top, tour guiado, Muscles | — | `Library` | lazy | shell: conta ou modo local |
| `/muscles` | Atleta, profissional, dual-role e admin | Library, Stats | — | `Muscles` | lazy | shell: conta ou modo local |
| `/structural-balance` | Atleta, profissional, dual-role e admin | Stats | — | `StructuralBalance` | lazy | shell: conta ou modo local |
| `/progress-photos` | Atleta, profissional, dual-role e admin | Stats | `body` | `ProgressPhotos` | lazy | shell: conta ou modo local; módulo `body` |
| `/measurements` | Atleta, profissional, dual-role e admin | Stats, AthleteToday | `body` | `Measurements` | lazy | shell: conta ou modo local; módulo `body` |
| `/settings` | Atleta, profissional, dual-role e admin | SyncBanner, tab bar, WorkoutSettingsSheet, tour guiado, Admin | — | `SettingsRoute` | lazy | shell: conta ou modo local |
| `/settings/:page` | Atleta, profissional, dual-role e admin | Integrations, Configurações | — | `SettingsRoute` | lazy | shell: conta ou modo local |
| `/professionals` | Atleta, profissional e dual-role | tab bar, Configurações, AthleteToday, CoachDashboard | — | `ProfessionalHub` | lazy | shell: conta ou modo local; modo/papel decidido dentro da view |
| `/scheduling` | Atleta, profissional e dual-role | tab bar, hub profissional, Configurações, AthleteToday, CoachDashboard | — | `SchedulingView` | lazy | shell: conta ou modo local; modo/papel decidido dentro da view |
| `/coach/groups` | Profissional (`kind=coach`), incl. Nutricionista | Configurações | — | `CoachGroupsView` | lazy | shell: conta ou modo local; guard de papel no router |
| `/coach/challenges` | Profissional (`kind=coach`), incl. Nutricionista | Configurações | — | `CoachChallengesView` | lazy | shell: conta ou modo local; guard de papel no router |
| `/coach/programs` | Profissional (`kind=coach`), incl. Nutricionista | Configurações | — | `CoachGroupProgramsView` | lazy | shell: conta ou modo local; guard de papel no router |
| `/athlete/groups` | Atleta; dual-role no modo atleta | Configurações | — | `AthleteGroupsView` | lazy | shell: conta ou modo local; sem guard de papel no router; API protege mutações |
| `/athlete/challenges` | Atleta; dual-role no modo atleta | Configurações, AthleteToday | — | `AthleteChallengesView` | lazy | shell: conta ou modo local; sem guard de papel no router; API protege mutações |
| `/athlete/programs` | Atleta; dual-role no modo atleta | Configurações | — | `AthleteGroupProgramsView` | lazy | shell: conta ou modo local; sem guard de papel no router; API protege mutações |
| `/community` | Atleta, profissional e dual-role | tab bar, AthleteChallengesView, AthleteGroupProgramsView, AthleteGroupsView, CoachChallengesView | — | `CommunityHub` | lazy | shell: conta ou modo local; modo/papel decidido dentro da view |
| `/join` | Atleta; dual-role no modo atleta | deep link / sem origem estática encontrada | — | `AthleteGroupsView` | lazy | shell: conta ou modo local |
| `/groups` | Atleta, profissional e dual-role | deep link / sem origem estática encontrada | — | redirect → `/coach/groups` / `/athlete/groups` | n/a | shell: conta ou modo local; guard de papel no router |
| `/challenges` | Atleta, profissional e dual-role | deep link / sem origem estática encontrada | — | redirect → `/coach/challenges` / `/athlete/challenges` | n/a | shell: conta ou modo local; guard de papel no router |
| `/group-programs` | Atleta, profissional e dual-role | deep link / sem origem estática encontrada | — | redirect → `/coach/programs` / `/athlete/programs` | n/a | shell: conta ou modo local; guard de papel no router |
| `/coach` | Todos os perfis; “Coach” aqui é IA | CoachChat, CoachIntake, CoachSetup, Integrations, Plan | `coach` | `CoachChat` | lazy | shell: conta ou modo local; módulo `coach` |
| `/coach/intake` | Todos os perfis; “Coach” aqui é IA | CoachChat | `coach` | `CoachIntake` | lazy | shell: conta ou modo local; módulo `coach` |
| `/coach/proposal` | Todos os perfis; “Coach” aqui é IA | deep link / sem origem estática encontrada | `coach` | redirect → `/coach` | n/a | shell: conta ou modo local; módulo `coach` |
| `/coach/setup` | Todos os perfis; “Coach” aqui é IA | Integrations, Configurações | `coach` | `CoachSetup` | lazy | shell: conta ou modo local; módulo `coach` |
| `/admin` | Admin | Configurações | — | `Admin` | lazy | shell: conta ou modo local; guard `user.admin` no router |
| `*` | Qualquer visitante do shell | fallback do router | — | redirect → `/home` | n/a | shell: conta ou modo local |
<!-- ux-audit:routes:end -->

## Menus e entradas não roteadas

- A barra inferior é fixa e igual para todos os papéis: Home, Plano, iniciar/retomar treino, Estatísticas e Exercícios.
- Configurações funciona como sub-router via `/settings/:page`; as páginas internas não aparecem como declarações independentes em `App.jsx`.
- `ProfessionalHub`, `SchedulingView` e `CommunityHub` alternam conteúdo por papel dentro da própria view; isso torna o acesso menos visível no inventário de router e aumenta o risco de inconsistência entre menu e deep link.
- `/coach` nomeia o assistente de IA legado, não o papel profissional. As rotas profissionais novas usam `/professionals`, `/scheduling`, `/coach/*` e `/athlete/*`, criando colisão semântica a resolver por aliases na Etapa 2.

## Limitações observadas

- Rotas `/athlete/*` não têm guard de papel no router. Isso é compatível com dual-role, mas exige que toda mutação permaneça autorizada na API.
- O fallback converte qualquer rota desconhecida em `/home`, sem estado de “não encontrado”; links quebrados ficam silenciosos.
- `Suspense` usa `fallback={null}` no helper de lazy loading, portanto um acesso antes do prefetch pode produzir um quadro vazio sem anúncio de carregamento.
- A origem é obtida por referências estáticas. Links formados dinamicamente, notificações, NFC, PWA e histórico podem não aparecer na coluna de origem.
