# Fundação B2B2C: profissionais e alunos

**Status:** aprovado para implementação incremental
**Versão:** 0.1.0
**Consulta de mercado:** 2026-11-06
**Escopo deste checkpoint:** Fase 0 e primeiro vertical slice da Fase 1, sem pagamentos.

## 1. Objetivo e princípios

O PR Fit evolui de um rastreador centrado no próprio usuário para uma plataforma B2B2C em que:

- o superadmin PR Fit administra a instância, sem acesso implícito aos dados de saúde para uso operacional;
- um `coach` pode atuar em treino, nutrição ou ambos;
- um `athlete` mantém a propriedade da conta e dos dados;
- acesso profissional depende de um vínculo explícito, auditável e limitado por escopo;
- um atleta pode manter vários vínculos simultâneos e independentes;
- término ou suspensão do vínculo revoga acesso futuro, sem apagar o histórico do atleta;
- autorização é decidida no backend; controles ocultos no frontend são apenas uma segunda camada de UX;
- pagamentos, cobrança, gateway e dados financeiros ficam fora deste checkpoint.

## 2. Estado atual confirmado

### Backend e persistência

- `api/server.js` é um servidor `node:http` sem framework. As rotas são chaves do objeto `routes`, no formato `METHOD /api/path`.
- `DATA_DIR/db.json` contém contas, credenciais WebAuthn, assinaturas push, convites administrativos e links de dispositivo. O arquivo é carregado em memória e salvo atomicamente, com cópia `db.json.bak`.
- Cada usuário possui um documento de treino separado em `state-<uid>.json`; `GET/PUT /api/data` só opera sobre o documento do usuário da sessão.
- Sessões usam cookie assinado ou bearer token pareado. O payload inclui usuário, expiração, versão de sessão e tipo.
- Administradores são definidos por `user.admin`, `ADMIN_UIDS` ou primeiro usuário, conforme configuração. Existe distinção adicional de owner da instância.
- O log `audit.log` já registra eventos de autenticação e administração com retenção configurável.
- Não existe versão explícita do schema de `db.json`, perfil B2B2C, vínculo coach-atleta, convite profissional ou autorização delegada.

### Frontend e autenticação

- A aplicação é React, React Router e Zustand.
- `frontend/src/store/useStore.js` mantém `user`, o documento pessoal `S`, boot, login, sincronização e persistência local.
- `frontend/src/lib/api.js` é o wrapper central de HTTP e preserva cookie same-origin ou bearer no aplicativo móvel pareado.
- `/api/me` é a fonte da identidade corrente; hoje retorna apenas os campos públicos básicos de conta e administração.
- A navegação principal é montada em `frontend/src/App.jsx`; `TabBar` representa a experiência de treino atual.
- i18n usa o texto inglês como chave e arquivos de tradução, incluindo `frontend/src/locales/pt-BR.js`.

### Offline e sincronização

- O documento de treino pessoal é salvo em `localStorage`, espelhado em arquivo no mobile e sincronizado com revisão otimista.
- O cliente envia `baseRev`; conflito responde `409`, é mesclado no cliente e reenviado.
- Metadados de identidade, credenciais e administração ficam em `db.json` e não participam do merge offline do treino.
- A fundação B2B2C deve seguir essa separação: papéis, convites e vínculos são dados server-authoritative. Operações de vínculo não entram em fila offline neste checkpoint.

### Gaps confirmados

1. Contas não declaram perfil `athlete`/`coach` nem especialidades.
2. Não há consentimento ou delegação por vínculo e escopo.
3. Um profissional não consegue listar sua carteira.
4. Não há convite opaco de coach para atleta, expiração ou aceite explícito.
5. Não há política reutilizável de autorização contra IDOR para recursos de atletas.
6. O sync atual não permite ao coach editar o documento de outro usuário e não deve ser aberto de forma global.
7. A UI não diferencia jornada profissional e jornada do atleta.
8. A especificação OpenAPI não descreve contratos B2B2C.

## 3. Personas

### Superadmin PR Fit

- administra disponibilidade, contas, segurança e operação da plataforma;
- concede ou revoga administração conforme o modelo existente;
- não se torna coach nem recebe acesso clínico/de treino por ser admin;
- pode futuramente operar suporte com trilha de auditoria e base legal específica.

### Profissional (`coach`)

- cria convites e administra sua carteira;
- declara especialidades `training` e/ou `nutrition`;
- acessa apenas atletas com vínculo `active` e somente capacidades autorizadas;
- não altera papel do atleta, credenciais, administração, consentimentos de outros coaches ou dados fora do escopo.

### Aluno (`athlete`)

- mantém conta e dados próprios;
- aceita ou recusa convites de forma explícita;
- visualiza profissionais, escopos e estados dos vínculos;
- pode ter mais de um profissional;
- pode encerrar vínculo sem perder histórico próprio.

### Conta legada

- é preservada sem alteração destrutiva;
- recebe perfil efetivo `athlete` por backfill compatível;
- mantém integralmente treino, sessão, credenciais e configuração existentes.

## 4. RBAC e capabilities

Papéis não substituem vínculos. O papel define o tipo de ator; o vínculo define quais dados de qual atleta podem ser acessados.

| Capability | Superadmin | Coach | Athlete | Condição adicional |
|---|---:|---:|---:|---|
| Administrar instância | sim | não | não | regras owner/admin existentes |
| Editar próprio perfil | sim | sim | sim | própria conta |
| Declarar perfil de coach | não automaticamente | sim | opt-in explícito | nunca concede admin |
| Criar convite profissional | não por admin | sim | não | especialidade cobre o escopo |
| Aceitar convite | não | se também atleta | sim | destinatário autenticado e token válido |
| Listar carteira | não por admin | sim | não | somente vínculos do próprio coach |
| Listar profissionais | não por admin | se também atleta | sim | somente vínculos do próprio atleta |
| Ler/escrever treino do atleta | não por admin | condicional | próprio | vínculo `active` + escopo `training` |
| Ler/escrever nutrição do atleta | não por admin | condicional | próprio | vínculo `active` + escopo `nutrition` |
| Suspender vínculo | não por admin | próprio vínculo | próprio vínculo | resultado bloqueia acesso delegado |
| Encerrar vínculo | não por admin | próprio vínculo | próprio vínculo | estado terminal lógico |
| Alterar papel/admin de terceiro | owner/admin atual | não | não | rotas administrativas existentes |

Capabilities iniciais:

- `relationships:invite`
- `relationships:list`
- `relationships:suspend`
- `relationships:end`
- `athlete:training:read`
- `athlete:training:write`
- `athlete:nutrition:read`
- `athlete:nutrition:write`

O primeiro slice implementa gestão do vínculo. Acesso ao documento de treino de outro usuário será aberto somente quando uma rota delegada puder aplicar capability e política de conflito adequadas; não será permitido reutilizar `GET/PUT /api/data?user=<id>`.

## 5. Modelo de domínio

### Perfil do usuário

Campos persistidos em `db.users[]`, compatíveis com contas antigas:

```json
{
  "id": "u_...",
  "name": "Nome",
  "profile": {
    "kind": "athlete",
    "coachSpecialties": []
  }
}
```

- `profile.kind`: `athlete` ou `coach` no primeiro slice.
- `coachSpecialties`: subconjunto não vazio de `training`, `nutrition` quando `kind=coach`; vazio para atleta.
- A ausência de `profile` é lida como atleta, permitindo rollback de binário sem reescrever estados de treino.
- especialidades usadas por vínculos não encerrados não podem ser removidas até esses vínculos terminarem.
- Futuro: perfil composto coach+athlete pode ser adicionado sem converter papel administrativo em papel de produto. No primeiro slice, um coach continua dono do próprio treino, mas a UI principal seleciona uma jornada.

### Vínculo coach-atleta

Persistido em `db.coachAthleteLinks[]`:

```json
{
  "id": "cal_...",
  "coachId": "u_coach",
  "athleteId": "u_athlete",
  "scopes": ["training"],
  "status": "active",
  "createdAt": "2026-11-06T00:00:00.000Z",
  "acceptedAt": "2026-11-06T00:05:00.000Z",
  "updatedAt": "2026-11-06T00:05:00.000Z",
  "endedAt": null,
  "suspendedBy": null
}
```

Invariantes:

- `coachId !== athleteId` no primeiro slice;
- coach e atleta existem;
- coach possui todas as especialidades solicitadas;
- `scopes` é um conjunto não vazio de `training` e/ou `nutrition`;
- um par coach-atleta pode ter no máximo um vínculo não encerrado;
- `ended` é terminal; novo relacionamento cria novo id e nova trilha;
- mudanças preservam timestamps e ator no log de auditoria.

### Convite opaco

Persistido em `db.coachInvites[]`, sem token em claro:

```json
{
  "id": "cai_...",
  "tokenHash": "sha256-base64url",
  "coachId": "u_coach",
  "scopes": ["training"],
  "createdAt": "2026-11-06T00:00:00.000Z",
  "expiresAt": "2026-11-13T00:00:00.000Z",
  "acceptedAt": null,
  "acceptedBy": null,
  "linkId": null
}
```

- token: 32 bytes aleatórios, codificados em base64url;
- somente o hash SHA-256 é persistido;
- expiração padrão: 7 dias, limitada no backend;
- aceite exige sessão autenticada e confirmação explícita;
- primeiro aceite cria o vínculo e marca o convite;
- replay pelo mesmo atleta retorna o mesmo vínculo, sem duplicar efeitos;
- replay por outro usuário retorna conflito genérico, sem revelar identidade;
- token inválido, expirado ou revogado retorna erro estável e sem enumeração.

### Estados e transições

```text
pending --accept--> active
pending --expire/revoke--> ended
active --suspend--> suspended
suspended --resume (futuro)--> active
active --end--> ended
suspended --end--> ended
```

No primeiro slice, `pending` existe no convite e na projeção de carteira. O vínculo materializado nasce `active` no aceite. Suspensão e encerramento são suportados; retomada fica explicitamente fora do checkpoint para evitar uma transição implícita sem UX de novo consentimento.

## 6. Isolamento, IDOR, privacidade e LGPD

### Política central

Toda rota que recebe `athleteId`, `linkId` ou outro identificador delegado deve chamar uma política central com:

1. ator autenticado;
2. recurso/vínculo carregado no servidor;
3. capability solicitada;
4. estado do vínculo;
5. escopo necessário.

Regras:

- nunca confiar em `coachId` ou `athleteId` enviados pelo cliente para definir o ator;
- buscar vínculo por id e validar ambos os lados contra a sessão;
- responder `404` para vínculo/recurso fora do alcance quando isso reduz enumeração;
- responder `403 scope_forbidden` quando a relação é conhecida pelo ator, mas o escopo não permite a operação;
- vínculos `pending`, `suspended` e `ended` não autorizam leitura ou escrita delegada;
- admin não ignora a política de vínculo;
- listagens filtram no servidor antes de serializar;
- respostas usam projeções públicas mínimas e nunca espalham o objeto de usuário persistido.

### Privacidade/LGPD

- finalidade: prestação de acompanhamento contratado/consentido;
- necessidade: compartilhar somente identificação mínima, escopo e dados necessários à capability;
- transparência: atleta vê profissional, especialidade, escopo, estado e datas relevantes;
- revogação: suspensão/encerramento bloqueiam acesso futuro imediatamente;
- conservação: encerrar vínculo não apaga treino do titular; retenção de auditoria segue configuração e futura política formal;
- segurança: tokens opacos, hash em repouso, sessão obrigatória no aceite e auditoria de transições;
- direitos do titular: exportação e exclusão da conta continuam usando fluxos existentes; efeitos sobre vínculos devem ser incluídos na remoção de conta;
- dados sensíveis: saúde e nutrição exigem controles adicionais antes das respectivas fases.

## 7. Contratos de API

Os nomes seguem o estilo REST simples já usado pelo servidor.

### Perfil

`GET /api/me`

```json
{
  "user": {
    "id": "u_...",
    "name": "Nome",
    "admin": false,
    "profile": { "kind": "coach", "coachSpecialties": ["training"] },
    "capabilities": ["relationships:invite", "relationships:list"]
  }
}
```

`POST /api/profile`

```json
{ "kind": "coach", "coachSpecialties": ["training"] }
```

- usuário autenticado altera somente o próprio perfil;
- a rota rejeita `admin`, `owner`, ids, capabilities arbitrárias e campos desconhecidos;
- mudança de coach para athlete é bloqueada enquanto houver vínculo não encerrado.

### Convites e vínculos

`POST /api/coach/invites`

Request:

```json
{ "scopes": ["training"], "expiresInDays": 7 }
```

Response `201`:

```json
{
  "invite": {
    "id": "cai_...",
    "token": "opaque-once",
    "scopes": ["training"],
    "expiresAt": "2026-11-13T00:00:00.000Z"
  }
}
```

`POST /api/coach/invites/accept`

Request:

```json
{ "token": "opaque-once" }
```

Response `200` para aceite e replay idempotente pelo mesmo atleta:

```json
{ "link": { "id": "cal_...", "status": "active", "scopes": ["training"], "coach": { "id": "u_...", "name": "Nome" } } }
```

`GET /api/coach/athletes`

- retorna convites pendentes do próprio coach e vínculos em todos os estados;
- inclui somente projeção pública do atleta após aceite.

`GET /api/athlete/coaches`

- retorna somente vínculos do atleta autenticado e projeção pública dos coaches.

`POST /api/coach/links/status`

```json
{ "linkId": "cal_...", "status": "suspended" }
```

- `suspended` e `ended` no primeiro slice;
- apenas um dos participantes do vínculo pode executar;
- `ended` é idempotente;
- transição inválida retorna `409 invalid_transition`.

### Envelope de erros

```json
{
  "error": "human readable fallback",
  "code": "stable_machine_code"
}
```

| HTTP | Código | Uso |
|---:|---|---|
| 400 | `invalid_profile` | perfil/especialidades inválidos |
| 400 | `invalid_scope` | escopo vazio, desconhecido ou não coberto |
| 401 | `not_signed_in` | sessão ausente/inválida |
| 403 | `role_forbidden` | ator não é coach para a ação |
| 403 | `scope_forbidden` | vínculo conhecido sem o escopo necessário |
| 404 | `relationship_not_found` | vínculo ausente ou fora do alcance |
| 409 | `invite_used` | token aceito por outro usuário |
| 409 | `relationship_exists` | já existe vínculo não encerrado |
| 409 | `invalid_transition` | transição de estado não permitida |
| 410 | `invite_invalid` | token inválido, expirado ou revogado |

## 8. UX mínima

### Onboarding/perfil

- após autenticação, conta sem escolha explícita continua como atleta sem modal bloqueante;
- Settings oferece “Perfil” com escolhas “Aluno” e “Profissional”;
- escolher profissional exige ao menos uma especialidade;
- nenhum fluxo altera `admin` ou `owner`;
- mudança mostra impacto e falhas retornadas pelo backend.

### Profissional: Meus alunos

- rota dedicada acessível para `profile.kind=coach`;
- empty state explica convite e escopos;
- criação de convite permite treino, nutrição ou ambos conforme especialidades;
- token/link é exibido uma vez com copiar/compartilhar;
- carteira separa pendentes, ativos, suspensos e encerrados;
- ações suspender/encerrar exigem confirmação e refletem resposta da API.

### Aluno: Meus profissionais

- rota dedicada para atleta;
- aceita token vindo de campo ou deep link `#/professionals?invite=...`;
- mostra nome, especialidades, escopos, estado e datas;
- aceite exige botão explícito; abrir o link não aceita automaticamente;
- encerramento exige confirmação.

### Acessibilidade e responsividade

- labels e mensagens não dependem apenas de cor;
- foco permanece previsível após criar ou aceitar convite;
- botões desabilitados explicam o motivo;
- cartões funcionam em viewport estreita e respeitam os componentes/tokens existentes;
- textos novos possuem inglês-base e tradução PT-BR.

## 9. Migração, backfill e reversibilidade

### Schema

- introduzir `db.schemaVersion`, iniciando em `2`;
- leitura de arquivo sem versão assume versão `1`;
- backfill em memória adiciona coleções vazias `coachInvites` e `coachAthleteLinks`;
- usuários sem `profile` recebem comportamento efetivo de atleta; a persistência explícita pode ocorrer no próximo `saveDb`, sem remover campos;
- migration deve ser idempotente e salvar antes de responder a operações B2B2C;
- `db.json.bak` preserva a mesma versão gravada.

### Contas e estados existentes

- ids, nomes, flags administrativas, credenciais, convites administrativos, push e sessões permanecem válidos;
- arquivos `state-<uid>.json` não são reescritos pela migração;
- mobile/local e modo guest permanecem com a experiência atual;
- remoção de conta deve remover convites profissionais e encerrar/remover referências do usuário sem apagar estados de terceiros.

### Reversibilidade

- versões antigas ignoram campos desconhecidos de `db.json` e continuam lendo usuários/credenciais;
- não há transformação destrutiva do documento de treino;
- rollback de aplicação preserva dados B2B2C no arquivo, embora a versão antiga não ofereça suas rotas;
- downgrade só é proibido futuramente se uma migração deixar de ser aditiva; isso exige ADR próprio.

## 10. Offline, sync e conflitos

- perfil, convite e vínculo exigem conexão; a UI deve informar indisponibilidade e não fingir sucesso offline;
- respostas B2B2C não são copiadas para o documento pessoal `S` e não participam de `mergeStates`;
- listagens podem ser mantidas apenas em memória e recarregadas ao abrir a tela ou após mutação;
- aceite e transições usam idempotência no servidor para tolerar retry após timeout;
- token é removido da URL após leitura para reduzir exposição em histórico/screenshot;
- mutações futuras de treino por coach precisarão de recurso com revisão própria e ator auditado. Não reutilizar cegamente a revisão do dispositivo do atleta;
- se atleta e coach editarem treino no futuro, o conflito deve preservar autoria, base revision e política por campo/recurso.

## 11. Roadmap numerado

1. **Fundação** — perfis, especialidades, vínculos, convites, autorização central, auditoria, UI mínima e migração aditiva.
2. **Treino** — templates, rotinas atribuíveis, biblioteca do profissional, prescrição com revisão, progresso e comentários, sem acesso global ao documento do atleta.
3. **Avaliações** — anamnese, PAR-Q, medidas, fotos, evolução, consentimento granular e retenção de dados sensíveis.
4. **Nutrição** — plano alimentar, metas de macros, substituições, check-ins e escopo nutricional independente.
5. **Comunicação e hábitos** — mensagens, check-ins, hábitos, lembretes, gamificação e automações de retenção com opt-out.
6. **Agenda** — disponibilidade, agendamentos, sessões e acompanhamento em tempo real com timezone e cancelamento.
7. **Programas e grupos** — programas replicáveis 1:N, coortes, desafios e regras de visibilidade entre participantes.
8. **White-label** — marca do profissional, domínio/tema e experiência customizada sem fragmentar autorização ou atualizações upstream.
9. **Analytics e IA** — métricas agregadas, alertas e assistência com explicabilidade, minimização, consentimento e isolamento por vínculo.
10. **Monetização posterior** — contratos de assinatura e entitlement separados da autorização clínica; gateway, recorrência, cobrança e dados financeiros somente em fase própria.

## 12. Evidência de mercado

As páginas abaixo são materiais públicos de ajuda, produto, demonstração, case ou comparação comercial consultados em 2026-11-06. A matriz registra sinais de mercado, não garantias técnicas. Alegações de escala, resultado, superioridade, disponibilidade ou integração são tratadas como **evidência de marketing** até validação independente.

| Produto/fonte | Capacidades sinalizadas | Tipo de evidência e cautela |
|---|---|---|
| MFIT — [central de ajuda](https://ajuda.mfitpersonal.com.br) | carteira, treino, acompanhamento e operação profissional | documentação de suporte pública; comportamento técnico deve ser validado por uso |
| MFIT — [criar treino para aluno](https://ajuda.mfitpersonal.com.br/ajuda/professor/como-criar-um-treino-para-o-meu-aluno-no-app-da-mfit) | prescrição individual de treino | artigo de ajuda; demonstra intenção de produto |
| MFIT — [planos de pagamento](https://ajuda.mfitpersonal.com.br/ajuda/professor/gerenciador-de-planos-de-pagamento/como-criar-um-plano-de-pagamento-para-os-meus-alunos) | planos/cobrança | artigo de ajuda; inspira roadmap, fora deste checkpoint |
| MFIT — [acompanhamento nutricional](https://ajuda.mfitpersonal.com.br/ajuda/aluno/e-possivel-fazer-acompanhamento-nutricional-pelo-app-da-mfit-2) | nutrição e acompanhamento por profissional | artigo de ajuda; não prova modelo de autorização interno |
| Nexur — [demo](https://aplicativonexur.com.br/demo-nexur) | demonstração de gestão de alunos e serviço digital | página comercial/demo; evidência de marketing |
| Nexur — [academias e personais](https://aplicativonexur.com.br/software-para-academias-personais) | carteira, treino, avaliações e operação de profissionais | página comercial; alegações devem ser tratadas como marketing |
| Tecnofit — [solução para personal](https://www.tecnofit.com.br/solucoes-tecnofit-personal) | alunos, treinos, avaliações, agenda e gestão | página comercial; não assumir arquitetura ou segurança |
| Trainerize — [produto](https://www.trainerize.com) | treino, nutrição, hábitos, mensagens, pagamentos e marca | página comercial; disponibilidade pode variar por plano |
| Trainerize — [getting started](https://help.trainerize.com/hc/en-us/articles/208688876-What-is-ABC-Trainerize-A-Getting-Started-Overview) | visão geral de coaching digital e relacionamento com clientes | documentação de suporte; ainda contém posicionamento do fornecedor |
| Everfit — [case That Muscle Guy](https://everfit.io/case-studies/that-muscle-guy-reaches-8x-more-clients-with-everfit) | programas escaláveis, automação e atendimento 1:N | case comercial; “8x” é alegação de marketing, não benchmark técnico |
| Master Training — [comparação com MFIT](https://mtapp.com.br/blog/master-training-vs-mfit-personal) | treino, avaliações, acompanhamento e comparação competitiva | conteúdo de fornecedor sobre concorrente; alto risco de viés comercial |

Síntese para o roadmap: o mercado comunica repetidamente carteira/convite, prescrição por templates, avaliações, agenda, nutrição, comunicação/hábitos, programas 1:N, marca e monetização. A fundação do PR Fit prioriza primeiro consentimento, escopo e isolamento, pois nenhuma página comercial substitui requisitos de segurança e privacidade.

## 13. Acceptance criteria

### Checkpoint A

- arquitetura, persistência, auth, frontend, testes e sync documentados a partir do repositório;
- matriz RBAC, domínio, transições, segurança, API, UX, migração, offline e roadmap versionados;
- fontes de mercado e data de consulta registradas, com alegações comerciais marcadas;
- ADR registra autorização por vínculo e persistência aditiva.

### Checkpoint B

- conta existente inicia como atleta efetivo sem perda de dados ou sessão;
- usuário pode escolher coach/athlete sem alterar `admin`/`owner`;
- coach só convida escopos cobertos por suas especialidades;
- convite usa token opaco, hash persistido, expiração, uso único e replay idempotente;
- atleta autenticado aceita explicitamente;
- coach lista apenas sua carteira; atleta lista apenas seus coaches;
- coach A não acessa vínculo ou atleta exclusivo do coach B;
- suspensão/encerramento revogam capabilities delegadas imediatamente;
- serialização nunca expõe credenciais, hashes, tokenHash, sessão, e-mail ou campos internos desnecessários;
- reload/restart preserva schema, convite usado e vínculo;
- auditoria registra criação, aceite, suspensão e encerramento.

### Checkpoint C

- UI oferece seleção segura de perfil e especialidades;
- coach possui tela “Meus alunos” com empty state, convite, estados e ações;
- atleta aceita convite e vê “Meus profissionais”;
- navegação e controles refletem capabilities, sem substituir enforcement do backend;
- inglês e PT-BR, teclado, leitor de tela e viewport móvel são cobertos;
- treino pessoal existente continua acessível e sincronizável.

## 14. Testes E2E e integração

1. Criar/bootar banco legado sem `schemaVersion`; autenticar e confirmar treino intacto.
2. Atleta tenta criar convite profissional: `403 role_forbidden`.
3. Usuário escolhe coach de treino; `/api/me` reflete perfil e capabilities sem admin.
4. Coach cria convite; banco contém apenas hash; resposta contém token uma única vez.
5. Token inválido e expirado retornam `410 invite_invalid` sem revelar coach/atleta.
6. Atleta aceita; vínculo fica `active`; segundo envio pelo mesmo atleta retorna o mesmo id.
7. Outro atleta reproduz token usado e recebe conflito sem dados privados.
8. Coach lista carteira e vê somente convites/vínculos próprios.
9. Coach A consulta/muta id do coach B e recebe `404 relationship_not_found`.
10. Atleta lista apenas seus profissionais e não consegue trocar `coachId`, papel ou escopo pela payload.
11. Suspender vínculo bloqueia a política `athlete:training:write` e `athlete:nutrition:write`.
12. Encerrar é idempotente e não remove `state-<athlete>.json`.
13. Reiniciar servidor preserva perfil, vínculos, convite consumido e idempotência.
14. Snapshots/respostas são inspecionados contra `credentialID`, `publicKey`, hashes, tokens, `sv`, e-mail e segredos.
15. UI oculta “Meus alunos” para atleta e bloqueia deep link sem perfil de coach.
16. UI não aceita convite ao abrir URL; exige ação explícita e remove token da barra após captura.

## 15. Fora de escopo deste slice

- pagamentos, recorrência, gateway, cartão, PIX, conta bancária ou faturamento;
- edição delegada do documento completo de treino;
- retomada de vínculo suspenso;
- mensagens, agenda, nutrição clínica, grupos, white-label ou IA sobre dados de alunos;
- impersonação administrativa ou acesso de suporte a dados de saúde.
