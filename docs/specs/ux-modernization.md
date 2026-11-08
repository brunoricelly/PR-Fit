# PR Fit — Programa de Homologação, UX e Modernização Visual

## Gate JEV vigente
- **Limiar**: **0,88**.
- **Fonte**: instrução explícita mais recente do usuário; substitui o valor anterior de 0,73 para todo o programa de UX.
- Executar decisão canônica somente no candidato final de cada release, após testes, builds, probes, inspeção do diff e auditorias.
- Score abaixo de 0,88, P0/P1 ou evidência bloqueada implica NO-GO.

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

**Gate:** dados reais/API, estados vazios e offline, testes de persistência do onboarding, E2E dos primeiros passos.

### Etapa 4 — Simplificação dos fluxos essenciais
Em subcheckpoints sequenciais:
1. convite/vínculo e permissões;
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
