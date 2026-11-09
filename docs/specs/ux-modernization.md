# PR Fit — Programa de Homologação, UX e Modernização Visual

## Gate JEV vigente
- **Limiar**: **0,85**.
- **Fonte**: instrução explícita mais recente do usuário; substitui o valor anterior de 0,88 para todo o programa de UX.
- Executar decisão canônica somente no candidato final de cada release, após testes, builds, probes, inspeção do diff e auditorias.
- Score abaixo de 0,85, P0/P1 ou evidência bloqueada implica NO-GO.

## Objetivo
Transformar o PR Fit atual em uma experiência simples, moderna, leve, acessível e autoexplicativa para treinadores, nutricionistas e alunos, sem adicionar White-label (Fase 9) ou Cobrança (Fase 10) neste ciclo.

## Governança
- Implementação exclusivamente pelo ORCA/Codex (`jev-code-expert`).
- Uma etapa por vez, em ordem; a etapa seguinte só inicia após testes, build, auditoria visual e commit verde da anterior.
- Hermes revisa diff, executa testes independentes, audita segurança/regressão e governa release.
- Nenhum deploy em produção antes da homologação completa e autorização do gate.
- Preservar todos os contratos backend, dados, permissões, multi-tenant/anti-IDOR, PWA/offline, AGPL e compatibilidade com upstream.

## Princípios de Produto
1. Mobile-first e uso confortável com uma mão.
2. Divulgação progressiva: funções avançadas aparecem apenas quando necessárias.
3. Uma ação principal clara por tela.
4. Linguagem PT-BR consistente e inclusiva; remover mistura de inglês visível.
5. Estados explícitos de loading, vazio, erro, sem permissão, offline e sucesso.
6. Ajuda contextual curta, sem tutoriais invasivos.
7. Acessibilidade WCAG 2.2 AA: contraste, teclado, foco, leitores de tela e alvos de toque >=44px.
8. Desempenho percebido: carregamento sob demanda, skeletons, ausência de layout shift e conteúdo principal rápido.
9. Um design system único, sem alterar a identidade canônica PR Fit.
10. Testes com as duas perspectivas: profissional e aluno, incluindo conta dual-role.

## Etapas

### Etapa 0 — Auditoria e baseline mensurável
- Inventariar rotas, menus, views, componentes, idiomas e fluxos por ator.
- Capturar screenshots desktop (1440), tablet (768), iPhone compacto (375) e Android (412) das telas críticas.
- Medir bundle, chunks, acessibilidade, overflow, console, navegação, estados e desempenho.
- Classificar cada problema por P0/P1/P2 e produzir backlog rastreável.
- Documentar mapa de informação atual e alvo.

**Gate:** artefatos de auditoria, baseline reprodutível, testes existentes e build verdes; nenhum código visual de produção nesta etapa salvo harness de auditoria/testes.

### Etapa 1 — Fundação do design system
- Tokens semânticos: cores, superfícies, texto, estados, spacing, radius, shadow, motion, z-index e tipografia.
- Componentes compartilhados: Button, IconButton, Input, Select, Checkbox/Switch, Card, PageHeader, Modal/Drawer, Toast, Alert, Skeleton, EmptyState, ErrorState, Tabs, Badge, Tooltip.
- Temas claro/escuro coerentes e `prefers-reduced-motion`.
- Story/demo interno ou testes visuais dos estados.

**Gate:** componentes acessíveis, responsivos, sem regressão de contraste; testes e build frontend completos.

### Etapa 2 — Arquitetura de informação e navegação por ator
**Coach:** Visão geral, Alunos, Treinos, Nutrição, Agenda, Comunicação, Grupos e desafios, Relatórios, Configurações.
**Aluno:** Hoje, Meu plano, Evolução, Comunidade, Agenda, Perfil.
- Navegação mobile e desktop com rotas existentes preservadas por aliases/redirecionamentos.
- Dual-role com alternância explícita Coach/Aluno.
- Módulos inativos não poluem a navegação.

**Gate:** matriz de rotas/roles/teclado/deep links; browser E2E para coach, atleta e dual-role.

### Etapa 3 — Dashboards e primeiro acesso
- Dashboard Coach orientado a atenção: agenda, mensagens, adesão, alunos que precisam de ação e atalhos.
- Dashboard Aluno “Hoje”: treino, alimentação/água, hábitos, agenda, mensagens e progresso semanal.
- Onboarding contextual por papel com checklist persistente, ignorável e retomável.
- Não inventar dados; cards sem fonte real devem ser omitidos ou neutros.

#### Implementação recortada — dashboards por intenção
- O primeiro checkpoint modernizou `/home`; o segundo adiciona onboarding contextual, não bloqueante e específico ao papel ativo na mesma superfície.
- Coach: alunos vêm de `GET /api/coach/athletes`, mensagens de `GET /api/messages/inbox`, agenda de `GET /api/coach/appointments` e adesão de `GET /api/coach/athletes/{athleteId}/habits-summary` com período de 7 dias.
- “Exige atenção” é derivado apenas de fatos já carregados: mensagem não lida, vínculo pendente/suspenso ou zero check-ins concluídos quando há dias programados na semana. Nenhum limiar novo de desempenho foi criado.
- Atleta: treino e progresso semanal usam o estado local sincronizado já existente; alimentação/água usam `GET /api/athlete/meal-plan` e `GET /api/athlete/meal-adherence`; hábitos usam `GET /api/athlete/habits`; agenda usa `GET /api/athlete/appointments`; mensagens usam `GET /api/messages/inbox`.
- Módulos remotos sem dados são omitidos. O atalho de check-in só aparece quando o módulo está habilitado e já existem cartões de academia.

#### Checkpoint 3B — primeiros passos por papel
- O checklist usa `localStorage` na chave `prfit_first_steps`, com payload `{ version: 1, entries: [...] }`. Cada entrada é isolada por `userId` e `role` (`coach` ou `athlete`); conta dual-role nunca compartilha progresso entre os papéis.
- O payload é validado integralmente antes do uso. JSON corrompido, versão desconhecida, duplicidade de escopo ou campos inválidos falham fechado para um estado vazio; a próxima gravação válida substitui o conteúdo inválido. A versão no envelope permite adicionar migrações explícitas em etapas futuras.
- Fechar apenas marca o checklist como pausado e exibe “Retomar primeiros passos”. Logout não apaga o payload: o histórico permanece para a mesma conta, mas o isolamento por `userId` impede que seja aplicado ao próximo usuário.
- Coach: vínculo existente conclui “primeiro aluno”; `GET /api/coach/availability` conclui disponibilidade configurada. Perfil e Comunidade são concluídos ao abrir a rota pelo checklist. Não há endpoint agregado confiável para provar uma prescrição em toda a carteira, então “primeiro treino” oferece marcação local explícita “Já fiz”, sem mutação de negócio.
- Atleta: rotinas locais concluem “Meu plano”; treino ativo real ou histórico local conclui “primeiro treino”. Perfil, Evolução e Comunidade são concluídos ao abrir as rotas correspondentes pelo checklist.
- Rotas Coach: `/settings`, `/professionals`, `/scheduling?tab=availability`, `/community`. Rotas Atleta: `/settings`, `/plan`, `/workout` quando há sessão ativa, `/stats`, `/community`.

**Gate:** dados reais/API, estados vazios e offline, testes de persistência do onboarding, E2E dos primeiros passos.

### Etapa 4 — Simplificação dos fluxos essenciais
Em subcheckpoints sequenciais:
1. convite/vínculo e permissões (Checkpoint 4.1 concluído):
   - Visão do Profissional (Coach/Nutri): área intuitiva de geração de convites com explicação clara dos escopos (treino, nutrição, avaliações), cópia direta de link/código com feedback visual e aria-live imediato, alvos de toque >= 44px. Carteira com badges do design system, filtro de status (ativos, pendentes, suspensos) e diálogos de confirmação proporcionais ao risco via Modal.jsx.
   - Visão do Aluno: tela de aceitação contextual explicitando o profissional solicitante e discriminando os dados compartilhados com garantia de privacidade, ações evidentes de aceitar e recusar (sem compartilhamento de dados ao recusar), e tratamento de erro descritivo em PT-BR via Alert e Toast.
2. prescrição/adoção de treino;
3. nutrição e aderência;
4. agenda/reagendamento;
5. comunicação/hábitos;
6. avaliações/evolução;
7. grupos/programas/desafios.
- Formulários em etapas onde houver complexidade.
- Revisão antes de publicar; autosave/rascunho somente quando contrato permitir.
- Erros dizem o que aconteceu e como corrigir.

**Gate por subcheckpoint:** API + frontend focados, build, anti-IDOR/role probes, mobile browser E2E, sem regressão de persistência.

### Etapa 5 — Linguagem, ajuda e estados
- PT-BR integral em superfícies visíveis; catálogo de cópia por domínio.
- Empty states educativos com CTA real.
- Ajuda contextual e “Como funciona?” em ações críticas.
- Confirmações proporcionais ao risco; ações destrutivas claras.
- Offline/retry e rate-limit sem loops ou falsos sucessos.

**Gate:** extração/i18n limpa, testes de cópia e estados, revisão humana por fluxo.

### Etapa 6 — Mobile/PWA e desempenho
- Lazy loading por rota, divisão de chunks e redução do first-load.
- Otimizar catálogos pesados, idiomas, imagens e ícones.
- Sem overflow horizontal, layout shift ou conteúdo invisível por animação.
- PWA update/offline coerente; toque >=44px e safe areas.

**Gate:** builds comparativos, métricas antes/depois, Lighthouse ou equivalente, browser matrix 375/390/412/768/1440, console limpo.

### Etapa 7 — Acessibilidade e consistência final
- Auditoria WCAG 2.2 AA, teclado, foco, modais, aria-live, headings e contraste.
- Remover controles decorativos, botões aninhados e padrões inconsistentes.
- Revisão de datas/timezones e formatos locais.

**Gate:** testes automatizados + exploração manual por teclado, zero P0/P1 de acessibilidade.

### Etapa 8 — Homologação com usuários e refinamento
- Roteiro de tarefas para 3–5 treinadores, 1–2 nutricionistas e 10–20 alunos.
- Registrar sucesso, tempo, hesitação, retorno, termos confusos e erros.
- Corrigir problemas por impacto, sem adicionar escopo não validado.

**Gate:** relatório de usabilidade, taxa de sucesso e backlog residual aceito.

### Etapa 9 — Release controlada
- Suítes completas API/frontend, build Vite e Docker, OpenAPI/docs, segurança/dependências/segredos.
- Diff final integral e duas auditorias independentes sem P0/P1.
- Staging/clone isolado para E2E antes de produção quando houver mutação de dados.
- Backup/rollback, canary e monitoramento pós-deploy.

## Critérios globais de conclusão
- Funções existentes continuam operacionais para coach, atleta, nutricionista e dual-role.
- Nenhuma tela crítica mistura PT-BR e inglês.
- Nenhuma rota crítica sem loading/empty/error/retry/permission/offline apropriado.
- Sem P0/P1, sem falha de teste/build, sem segredos ou vulnerabilidade alta nova.
- Produção só após prova UI/API/DB/logs/persistência e rollback verificável.

## Etapa 6A — baseline de carregamento por rota

Baseline reproduzida em 2026-11-09, antes de qualquer edição do checkpoint, no commit
`64c87e91498e365bcfd0aceb53087c709ad52eff`, com Node/Vite instalados no worktree e
`npm run build --prefix frontend`.

### Saída de produção da base

- 160 chunks JavaScript e 9 folhas CSS (169 assets JS/CSS no total).
- O HTML referencia 42 assets de entrada: 41 JavaScript (entry + `modulepreload`) e a folha CSS
  principal. Esses assets somam 3.007.305 bytes brutos e 717.648 bytes gzip; este é o proxy
  disponível para JavaScript/CSS do shell inicial, pois o repositório não mede first-load de rede.
- Entry principal: `index-*.js`, 652.273 bytes brutos e 200.888 bytes gzip.
- Catálogo de exercícios no preload inicial: `exercises-*.js`, 1.225.305 bytes brutos e 155.687
  bytes gzip.
- Outros preloads relevantes do shell: `sheets-*.js` 375.003/119.542 bytes bruto/gzip,
  `professional-copy-*.js` 69.818/21.360, `history-*.js` 54.797/20.108,
  `useStore-*.js` 50.857/17.888, `sync-merge-*.js` 50.204/17.314,
  `ui-*.js` 38.298/11.183 e `rotation-*.js` 37.040/13.034.
- CSS inicial: `index-*.css`, 203.647 bytes brutos e 38.854 bytes gzip.
- Maior chunk JavaScript: locale inglês `en-*.js`, 1.794.898 bytes brutos e 307.771 bytes gzip.
  O segundo maior é `hi-*.js` (1.585.003/119.528) e o terceiro é `exercises-*.js`
  (1.225.305/155.687).
- Total de JavaScript emitido, incluindo packs de idioma e chunks sob demanda: 29.457.261 bytes
  brutos e 5.945.796 bytes gzip. Esse total não representa first-load.

### Grafo real e comportamento da base

- `main.jsx` carrega estaticamente `App.jsx`, store, sincronização de mídia, teclado nativo e os
  estilos globais. `App.jsx` carrega estaticamente Login, onboarding, Home, Plano e Treino, além de
  `sheets.jsx` e módulos de watch/widget/voz. Esse caminho traz catálogo de exercícios, histórico,
  folhas e utilitários para o preload inicial mesmo quando a sessão abre em outra superfície.
- Admin, chat, medições, fotos, profissional, agenda, comunidade, grupos, desafios, programas,
  check-in, editor de rotina, programas, evolução, histórico, biblioteca, músculos e configurações
  usam `React.lazy`; porém o helper da base usa `Suspense fallback={null}` e agenda o preload de
  todas as views após 1,5 s (ou em idle), portanto “lazy” não significa ausência de download logo
  após o shell.
- `ProfessionalHub.jsx` importa estaticamente Agenda, Comunidade, Nutrição, Comunicação/Hábitos e
  Relatórios/Evolução; abrir o hub profissional alcança todas essas superfícies no mesmo grafo.
- Warnings do build: chunks acima de 1.500 kB; import dinâmico ineficaz de `@capacitor/core`, que
  também possui consumidores estáticos; import dinâmico ineficaz de `scan-web.js`, também importado
  estaticamente por `CameraScan.jsx`.
- Navegação interna e abertura direta por hash/deep link preservam a rota, mas uma view lazy exibe
  conteúdo vazio enquanto baixa (`fallback={null}`). Rejeição do import chega ao `ErrorBoundary`
  genérico e só oferece recarregar a aplicação inteira; não há retry isolado do chunk. Aliases de
  grupos/desafios/programas continuam sendo resolvidos por `Navigate`; um caminho sem hash não é
  uma rota pública suportada e não foi reinterpretado neste checkpoint.

### Candidato 6A

- Todas as views declaradas no router usam `createRouteSurface`, baseado em `React.lazy` e
  `Suspense`. Home, Plano e Treino deixaram o entry estático; dentro de Home, os dashboards de
  treinador e atleta também são carregados por papel, sem baixar a outra visão.
- O preload oportunista de todas as rotas após 1,5 s foi removido. Uma rota baixa quando é
  solicitada; uma view já resolvida fica em cache para navegação, preview de back-swipe e retorno.
- O fallback usa o Design System, mantém uma área com altura estável, expõe um único `role=status`
  com cópia PT-BR contextual e marca o conteúdo como `aria-busy`; skeletons são decorativos.
- Falha de import fica contida na superfície, mostra erro em PT-BR e permite um retry explícito.
  Cada clique cria uma nova instância lazy; não há retry automático nem loop. Erros de render que
  não são falhas de chunk continuam subindo para o `ErrorBoundary` global existente.
- `CameraScan` deixou de importar `scan-web.js` estaticamente. O decoder é carregado ao abrir a
  câmera web, removendo o warning de import dinâmico ineficaz desse módulo. O warning restante é o
  de `@capacitor/core`, causado por dependências Capacitor que também o importam estaticamente.
- O inventário canônico reconhece `createRouteSurface` como lazy. O gate de build mede o HTML e os
  assets sem fixar hashes e falha acima de: 2.780.000 bytes brutos / 660.000 gzip no shell,
  42 assets iniciais, 1.813.000/311.000 no maior chunk bruto/gzip e 176 chunks JavaScript. Esses
  limites exigem redução real contra a base, limitam o maior chunk a aproximadamente +1% e limitam
  a contagem de chunks a +10%.

### Comparativo base → candidato

| Proxy de produção | Base | Candidato | Variação |
| --- | ---: | ---: | ---: |
| Shell referenciado por `index.html`, bruto | 3.007.305 B | 2.749.534 B | -257.771 B (-8,57%) |
| Shell referenciado por `index.html`, gzip | 717.648 B | 641.129 B | -76.519 B (-10,66%) |
| Entry `index-*.js`, bruto | 652.273 B | 413.028 B | -239.245 B (-36,68%) |
| Entry `index-*.js`, gzip | 200.888 B | 127.686 B | -73.202 B (-36,44%) |
| Assets iniciais referenciados | 42 | 42 | 0 |
| Chunks JavaScript emitidos | 160 | 176 | +16 (+10,00%) |
| Maior chunk bruto | 1.794.898 B | 1.794.898 B | 0 |
| Maior chunk gzip | 307.771 B | 307.771 B | 0 |

O maior chunk continua sendo o pack inglês `en-*.js`; hashes não participam do budget. Dois builds
consecutivos produziram a mesma estrutura e os mesmos tamanhos normalizados. O build ainda avisa
sobre packs acima de 1.500 kB e sobre `@capacitor/core`; o limite não foi afrouxado para ocultá-los.
