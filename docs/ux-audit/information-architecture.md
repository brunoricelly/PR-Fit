# Arquitetura de informação

## Mapa atual

```text
Shell global (conta ou modo local)
├─ Barra inferior universal
│  ├─ Home /home
│  ├─ Plano /plan
│  ├─ Iniciar/retomar /workout
│  ├─ Estatísticas /stats
│  └─ Exercícios /library
├─ Subfluxos pessoais
│  ├─ Histórico, músculos, equilíbrio, fotos e medidas
│  ├─ Rotinas e programas
│  └─ Check-in
├─ Configurações /settings/:page
│  ├─ conta, visual, módulos, equipamento, integrações...
│  ├─ Profissionais /professionals
│  ├─ Agenda /scheduling
│  ├─ Comunidade e rotas /coach/* + /athlete/*
│  └─ Admin /admin
└─ AI Coach /coach, /coach/intake, /coach/setup
```

Dentro de `/professionals` há outra arquitetura: Relacionamentos, Agenda e Comunidade; em Relacionamentos são embutidos prescrições, nutrição, avaliações, comunicação/hábitos e progresso. Agenda e Comunidade também têm rotas próprias. O resultado é duplicação de entrada e pouca previsibilidade de onde uma tarefa vive.

## Mapa alvo aprovado

O mapa abaixo reproduz a Etapa 2 do plano mestre; esta Etapa 0 não altera navegação.

```text
Coach / profissional
├─ Visão geral
├─ Alunos
├─ Treinos
├─ Nutrição
├─ Agenda
├─ Comunicação
├─ Grupos e desafios
├─ Relatórios
└─ Configurações

Aluno
├─ Hoje
├─ Meu plano
├─ Evolução
├─ Comunidade
├─ Agenda
└─ Perfil
```

Para Nutricionista, o contrato técnico continua sendo profissional `kind=coach` com especialidade `nutrition`. Até pesquisa de linguagem na Etapa 8, o mapa deve reutilizar a estrutura profissional, ocultar módulos sem especialidade e tratar “Alunos/Pacientes” como decisão de cópia, não como mudança de autorização.

Dual-role precisa de alternância Coach/Aluno explícita e persistente no shell. O modo selecionado deve controlar mapa, Home e atalhos; não pode alterar permissões nem transformar o lado atleta de um vínculo em papel profissional.

## Canonicalização e aliases necessários

Os paths canônicos são proposta operacional para a Etapa 2; os paths atuais permanecem como aliases/redirecionamentos para preservar bookmarks, notificações, PWA e links externos.

| Destino alvo | Path canônico proposto | Compatibilidade obrigatória |
| --- | --- | --- |
| Coach — Visão geral | `/professional/overview` | preservar `/home`; escolher destino por modo sem loop |
| Coach — Alunos | `/professional/athletes` | `/professionals?tab=relationships` |
| Coach — Treinos | `/professional/training` | prescrições hoje embutidas em `/professionals` |
| Coach — Nutrição | `/professional/nutrition` | painel hoje embutido por vínculo |
| Coach — Agenda | `/professional/schedule` | `/scheduling` com modo coach |
| Coach — Comunicação | `/professional/messages` | inbox hoje embutida em `/professionals` |
| Coach — Grupos e desafios | `/professional/community` | `/community`, `/coach/groups`, `/coach/challenges`, `/coach/programs`, `/groups`, `/challenges`, `/group-programs` |
| Coach — Relatórios | `/professional/reports` | progress analytics hoje embutido |
| Aluno — Hoje | `/today` | `/home` |
| Aluno — Meu plano | `/my-plan` | `/plan`, `/plan/r/:id`, `/plan/programmes`, `/plan/prog/:id` |
| Aluno — Evolução | `/progress` | `/stats`, `/history`, `/muscles`, `/structural-balance`, `/progress-photos`, `/measurements` |
| Aluno — Comunidade | `/community` | `/athlete/groups`, `/athlete/challenges`, `/athlete/programs`, `/join` |
| Aluno — Agenda | `/schedule` | `/scheduling` com modo atleta |
| Aluno — Perfil | `/profile` | `/settings`, especialmente `/settings/account` |
| AI Coach | `/ai-coach` | preservar `/coach`, `/coach/intake`, `/coach/proposal`, `/coach/setup` |

O prefixo proposto `/professional` evita usar `/coach` para duas entidades diferentes. A migração deve ser aditiva: primeiro aliases e testes de deep link; depois navegação; remoção de paths antigos não faz parte deste programa.

## Riscos de compatibilidade

1. **HashRouter e links externos:** todos os links reais usam `#/...`; redirects precisam preservar query string, convite e `location.state` quando aplicável.
2. **`/coach` ambíguo:** hoje é IA, enquanto `/coach/groups` é papel profissional. Um redirect ingênuo pode quebrar setup, notificações ou módulos desligados.
3. **Módulos desligados:** rotas condicionais caem no catch-all e parecem “Home”. Aliases precisam distinguir indisponível, sem permissão e não encontrado.
4. **Dual-role:** o modo visual não pode ser deduzido apenas de `profile.kind`; usuários profissionais podem ser atletas em vínculos e agenda.
5. **Autorização:** esconder menu não substitui políticas da API. As proteções anti-IDOR e escopos atuais devem continuar fonte de verdade.
6. **Rotas embutidas:** extrair painéis para URLs próprias pode remountar estado, repetir requests e perder cursor/filtros; contratos de cache e retorno precisam ser definidos.
7. **PWA/mobile/back:** tab roots usam `replace`, Android Back tem lógica própria e edge-swipe guarda histórico; aliases precisam entrar na matriz de navegação.
8. **Analytics e suporte:** docs, screenshots e instruções ainda usam Home/Plan/Stats e `/coach`; a migração precisa de glossário e período de compatibilidade.

## Decisões adiadas

- Não definir nesta etapa se “Alunos” vira “Clientes” ou “Pacientes” para Nutricionista.
- Não alterar tabs, paths, labels ou redirects de produção.
- Não fundir `/stats` com progress analytics antes de mapear contratos, consentimentos e diferenças entre dado local e dado profissional.
