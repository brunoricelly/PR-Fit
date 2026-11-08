# Inventário de telas

## Convenções

- **Dados reais** identifica a fonte já usada; nenhum card ou estado foi inferido como funcional sem contrato existente.
- **L/E/R/O** significa Loading / Empty / Error+retry / Offline. `S` é o estado local-first sincronizado; “API profissional” cobre endpoints reais de relacionamento, agenda, comunicação, nutrição, avaliações, progresso, grupos e desafios.
- O inventário separa papel de negócio de rota. No modelo atual, Nutricionista é `profile.kind === 'coach'` com especialidade `nutrition`; dual-role mantém perfil profissional e também pode ocupar o lado atleta de vínculos.

## Superfícies compartilhadas

| Tela / rota | Atores | Tarefa principal | Dados reais | L/E/R/O | Problemas observados |
| --- | --- | --- | --- | --- | --- |
| Login / interceptação global | Visitante | Entrar, recuperar acesso ou usar localmente | sessão, passkeys, senha e device link | Sim / Sim / Sim / Parcial | Não é uma rota própria; qualquer deep link sem autenticação vira Login e perde contexto visível. |
| Home `/home` | Todos | Ver treino do dia, semana, peso e atalhos | `S`, fila/rotação, sync | N/A / Sim / Não / banner global | Mesma Home para todos; não existe visão profissional orientada a atenção. Sem landmark `<main>`. |
| Plano `/plan` | Todos | Organizar semana/rotação e rotinas | `S.routines`, agenda local e filas | N/A / Sim / Não / local-first | Hierarquia salta de `h1` para `h4`; ações de compartilhar, importar, programas e edição competem na mesma área. |
| Rotina `/plan/r/:id` | Todos | Editar exercícios, progressão e ordem | rotina em `S`, catálogo real | N/A / Sim / validação local / local-first | Fluxo extenso e denso; depende de sheets e gestos, com risco em 375 px. |
| Programas `/plan/programmes`, `/plan/prog/:id` | Todos | Criar/adotar programas de treino | programas reais em `S` | N/A / Sim / validação local / local-first | Nomenclatura “programmes” diverge de `/coach/programs` e do alvo “Treinos”. |
| Treino `/workout` | Todos | Iniciar, registrar e finalizar sessão | `S.active`, histórico, mídia e sync | Parcial / Sim / Parcial / local-first | View de 2.606 linhas e alta densidade; sem `<main>`; estados de erro são locais e dispersos. |
| Evolução `/stats` | Todos | Ler volume, força, fadiga, músculos e peso | histórico real de `S` | N/A / Sim / Não / local-first | Nove `h2` e cinco `h4` sem `h3`; navegação de evolução está fragmentada em subrotas. |
| Histórico `/history` | Todos | Consultar/editar treinos passados | `S.workouts` | N/A / Sim / Não / local-first | É subfluxo de Stats, mas URL e cabeçalho não explicitam breadcrumb. |
| Músculos `/muscles` | Todos | Explorar exercícios ou carga por músculo | catálogo e histórico reais | N/A / Sim / Não / local-first | Pode nascer de Stats ou Biblioteca; parent tab depende de `location.state`, frágil em deep link. |
| Equilíbrio estrutural `/structural-balance` | Todos | Comparar lifts com referências | histórico e templates locais | N/A / Sim / Não / local-first | Ferramenta avançada aparece no mesmo nível de evolução geral. |
| Fotos e medidas `/progress-photos`, `/measurements` | Todos com módulo Body | Registrar evolução corporal | `S`, mídia local/remota | Parcial / Sim / Parcial / parcial | Rotas somem com módulo desligado e caem silenciosamente em Home. |
| Exercícios `/library` | Todos | Buscar catálogo e adicionar ao plano | catálogo versionado e mídia | Parcial / Sim / Não / mídia pode falhar | É uma aba principal universal, embora para profissionais o trabalho principal seja prescrever a um atleta. |
| Check-in `/checkin` | Todos com módulo | Gerir códigos/NFC de academia | `S` e NFC | N/A / Sim / Parcial / local-first | Descoberta depende de Home/NFC; rota desaparece sem feedback se o módulo for desligado. |
| Configurações `/settings/:page` | Todos | Conta, aparência, módulos, equipamentos e integrações | `S`, config, sessão e APIs | Parcial / Sim / Sim / parcial | Atua como gateway para funções de produto (profissionais, agenda, comunidade e admin), misturando configuração e trabalho diário. |
| AI Coach `/coach*` | Todos com módulo | Configurar, responder intake e conversar com IA | API Coach/config real | Sim / Sim / Sim / Parcial | O prefixo `/coach` colide semanticamente com o papel Coach profissional. Lazy fallback global é vazio. |

## Coach / profissional de treino

| Tela / rota | Tarefa principal | Dados reais | L/E/R/O | Problemas observados |
| --- | --- | --- | --- | --- |
| Hub profissional `/professionals` | Configurar perfil, convidar/vincular atletas e acompanhar vínculos | `/api/profile`, `/api/coach/athletes`, convites e status | Sim / Sim / Sim / erro genérico | Reúne relacionamento, treino, nutrição, avaliação, mensagens, hábitos e progresso numa página longa. |
| Prescrições (embutida no hub) | Criar rotina e prescrever para atleta | `/api/coach/*prescriptions*` | Parcial / Sim / Sim / não dedicado | Editor completo fica dentro do card do vínculo; não há área “Treinos” global do Coach. |
| Nutrição (embutida) | Definir plano alimentar e acompanhar adesão | APIs de meal plan/adherence | Sim / Sim / Sim / não dedicado | Módulo aparece por vínculo e não como fila de pacientes/pendências. |
| Avaliações (embutida) | Registrar e acompanhar avaliações físicas | `/api/assessments/config` e endpoints por atleta | Sim / Sim / Sim / não dedicado | Depende de especialidade e consentimento, mas a arquitetura não explica o escopo antes da entrada. |
| Comunicação e hábitos (embutida) | Ler/enviar mensagens e gerir hábitos | APIs de comunicação/hábitos | Sim / Sim / Sim / não dedicado | Mensagens ficam repetidas por vínculo; não existe caixa de entrada única na navegação. |
| Progresso e relatórios (embutida) | Ver resumo, metas e relatórios exportáveis | APIs de progress analytics | Sim / Sim / Sim / não dedicado | Conteúdo analítico profundo está aninhado dentro de “Relacionamentos”. |
| Agenda `/scheduling` | Disponibilidade, sessões e lembretes | APIs de scheduling e vínculos | Sim / Sim / Sim / não dedicado | Existe isolada e também embutida no hub; duas entradas para a mesma tarefa. |
| Comunidade `/community`, `/coach/*` | Criar grupos, desafios e programas coletivos | APIs reais de group challenges | Sim / Sim / Sim / não dedicado | Três rotas diretas mais hub embutido; abas horizontais têm `min-height: 42px`, abaixo do alvo de 44 px. |

## Nutricionista

| Tela / rota | Tarefa principal | Dados reais | L/E/R/O | Problemas observados |
| --- | --- | --- | --- | --- |
| Hub profissional `/professionals` | Vincular pacientes/atletas e gerir escopo nutricional | mesmos contratos de relacionamento; especialidade `nutrition` | Sim / Sim / Sim / não dedicado | UI usa “coach/athlete” como modelo técnico; terminologia “Alunos” pode ser inadequada para nutrição. |
| Nutrição por vínculo | Prescrever plano e acompanhar refeições | meal plan/adherence reais | Sim / Sim / Sim / não dedicado | É a tarefa primária do Nutricionista, mas fica enterrada no vínculo. |
| Comunicação, agenda e progresso | Acompanhar, conversar e marcar atendimento | APIs reais por escopo | Sim / Sim / Sim / não dedicado | Sem dashboard próprio ou filtro por necessidade de ação. |
| Grupos/desafios `/coach/*` | Criar comunidade/programas | group APIs | Sim / Sim / Sim / não dedicado | Router libera qualquer `kind=coach`, inclusive perfil somente `nutrition`; relevância e política de produto precisam ser validadas. |

## Atleta

| Tela / rota | Tarefa principal | Dados reais | L/E/R/O | Problemas observados |
| --- | --- | --- | --- | --- |
| Profissionais `/professionals` | Aceitar convite, gerir vínculos e consentimentos | `/api/athlete/coaches`, convites e status | Sim / Sim / Sim / não dedicado | Mistura também nutrição, avaliações, progresso e mensagens; excesso de divulgação inicial. |
| Minha nutrição / adesão | Ver plano e marcar refeições | `/api/athlete/meal-plan`, `/api/athlete/meal-adherence` | Sim / Sim / Sim / não dedicado | Não aparece na navegação principal do aluno. |
| Minhas avaliações | Ver avaliações consentidas | `/api/athlete/assessments` | Sim / Sim / Sim / não dedicado | Escondida no hub profissional. |
| Meu progresso profissional | Ler metas, relatórios e resumos | progress analytics | Sim / Sim / Sim / não dedicado | Duplica conceitos de `/stats` sem arquitetura unificada de “Evolução”. |
| Agenda `/scheduling` | Marcar, reagendar/cancelar e configurar lembretes | scheduling real | Sim / Sim / Sim / não dedicado | Agenda não está na tab bar; entrada principal passa por Configurações/hub. |
| Comunidade `/community`, `/athlete/*`, `/join` | Entrar em grupos, desafios e adotar programas | group APIs reais | Sim / Sim / Sim / não dedicado | Rotas `/athlete/*` não têm guard de papel no router; role switch do hub aparece para qualquer perfil truthy. |

## Dual-role

| Tela / rota | Tarefa principal | Dados reais | L/E/R/O | Problemas observados |
| --- | --- | --- | --- | --- |
| Hub profissional | Operar como profissional e também ver seus próprios profissionais | ambos os lados dos vínculos | Sim / Sim / Sim / não dedicado | Renderiza portfolio Coach e bloco Atleta juntos, sem alternância global explícita. |
| Agenda | Alternar Coach/Atleta | contratos reais dos dois lados | Sim / Sim / Sim / não dedicado | Tem switch local explícito, mas o modo não governa Home, tabs ou demais módulos. |
| Comunidade | Alternar Coach/Atleta | contratos reais dos dois lados | Sim / Sim / Sim / não dedicado | `canSwitchRole = isCoach || user?.profile` também libera o switch para atleta comum; estado não é compartilhado com Agenda. |

## Admin

| Tela / rota | Tarefa principal | Dados reais | L/E/R/O | Problemas observados |
| --- | --- | --- | --- | --- |
| Admin `/admin` | Usuários, sessões ativas, convites, recuperação, roles e auditoria | `/api/admin/*` real | Sim / Sim / Sim / não dedicado | 46 strings/atributos visíveis em inglês; sem `<main>`/landmarks; acesso só por Configurações. |
| Admin Coach (seção interna) | Provedor, limites, teste e jobs do AI Coach | config/job APIs reais | Sim / Sim / Sim / não dedicado | 32 strings/atributos visíveis em inglês; “Coach” mistura produto IA e papel humano. |

## Síntese

- O frontend tem 35 declarações de rota, mas várias “telas” de negócio são painéis embutidos; por isso a complexidade percebida é maior que a contagem de URLs.
- As views profissionais novas têm estados de loading/empty/error/retry mais completos que as views locais legadas. Nenhuma delas apresenta estado offline específico; falhas de rede aparecem como erro genérico.
- A navegação global continua centrada no atleta individual. Coach, Nutricionista e dual-role entram em tarefas diárias por Configurações ou por um hub excessivamente amplo.
