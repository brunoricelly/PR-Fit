# Fase 3 — avaliações físicas ponta a ponta

## Objetivo

Entregar avaliações físicas sensíveis como um fluxo web completo entre profissional e aluno, com
consentimento específico, validação clínica defensiva, persistência fail-closed, fotos privadas,
histórico/evolução e direitos do titular. A funcionalidade não diagnostica condições de saúde.

## Modelo e migração

- `db.schemaVersion = 4` adiciona `coachAssessments` e mantém migração aditiva das versões 1–3.
- Coleção ausente é inicializada como `[]`; coleção, registro ou data corrompida recusa o boot sem
  alterar `db.json` ou `db.json.bak`.
- Vínculos legados preservam seus escopos. A migração nunca adiciona `assessments` silenciosamente.
- PAR-Q legado com sete booleanos migra para `version: "2024.1"` e respostas com IDs estáveis.
- Registros não expõem `coachId`, `athleteId` ou `photoOwnerId`; as partes públicas contêm apenas nome.

## Consentimento e autorização

- `assessments` é um escopo independente de `training` e `nutrition`.
- O profissional precisa declarar a especialidade, possuir vínculo ativo e receber consentimento no
  vínculo para ler, criar, corrigir, excluir ou abrir fotos.
- O aluno concede/revoga em `POST /api/athlete/coaches/{linkId}/assessment-consent`.
- Revogar bloqueia acesso futuro do profissional, preservando o histórico e o controle do aluno.
- Convites novos podem incluir o escopo, mas só se tornam ativos após aceite explícito do aluno.
- Toda autorização usa o par profissional/aluno atual; IDs de outra relação retornam 404/403 sem IDOR.

## Dados e validação

- Data, peso, altura, perímetros, bioimpedância, Pollock 3, Pollock 7 e Faulkner 4.
- Anamnese limitada: histórico relevante e lesões (2.000 caracteres), medicamentos, objetivos e
  contraindicações (1.000), além de notas gerais (2.000).
- `assessedAt` rejeita futuro acima do clock skew e passado acima da idade máxima configurada.
- Pollock/Siri/Faulkner precisam produzir percentual finito entre 0 e 100 antes da composição
  corporal; fora do domínio responde `400 invalid_assessment`, nunca 500.
- PAR-Q usa perguntas versionadas e IDs estáveis. Qualquer resposta positiva persiste
  `requiresMedicalClearance` e mostra aviso não diagnóstico de avaliação/liberação profissional antes
  de atividade. A UI exige registrar que a orientação foi apresentada.

## Persistência, quotas e retenção

- Criação, correção e exclusão trocam a coleção somente se `saveDb()` concluir; falha restaura o
  estado em memória e responde `503 storage_unavailable`.
- Limite justo é contado por `(coachId, athleteId)`; outro profissional não consome a quota do par.
- Há também teto global e throttle de criação por conta e endereço no `B2B2C_RATE_WINDOW_MS`.
- Retenção padrão: 3.650 dias por `assessedAt`; compactação remove avaliações além da janela.
- Variáveis operacionais estão em `.env.example`: quotas, retenção, datas e rate limits.

## Fotos de progresso

- No máximo seis imagens JPEG/PNG/WebP por avaliação, com refs hash/tipo/tamanho/dimensões em
  `db.json`; bytes permanecem em `DATA_DIR/uploads` no subsistema de mídia existente.
- Upload passa por sniffing, quota, tamanho, hash e armazenamento privado já existentes.
- Download usa `/api/assessments/{assessmentId}/photos/{hash}`, `private, no-store`, `nosniff` e
  autorização do aluno ou do profissional criador com consentimento ainda ativo.
- Correção/exclusão remove o blob quando nenhuma avaliação nem estado pessoal ainda o referencia;
  GC continua protegendo uploads interrompidos e refs de outros recursos.

## Endpoints

- `GET /api/assessments/config`
- `GET|POST /api/coach/athletes/{athleteId}/assessments`
- `GET|PATCH|DELETE /api/coach/athletes/{athleteId}/assessments/{assessmentId}`
- `GET /api/athlete/assessments`
- `DELETE /api/athlete/assessments/{assessmentId}` com confirmação exata do ID
- `POST /api/athlete/coaches/{linkId}/assessment-consent`
- `GET /api/assessments/{assessmentId}/photos/{hash}`

O contrato completo, códigos 400/401/403/404/409/429/503 e schemas estão em `api/openapi.yaml`.

## Web

- Profissional: cartões de alunos autorizados, criação/correção, protocolos e dobras condicionais,
  PAR-Q/anamnese, fotos, lista, detalhe, evolução, erros recuperáveis e exclusão confirmada.
- Aluno: histórico próprio, alerta PAR-Q, evolução cronológica responsiva (peso, gordura, massa magra,
  cintura, quadril e braço com deltas), consentimento/revogação e exclusão própria confirmada/auditada.
- Estados vazios, loading e retry seguem os componentes e tokens do `ProfessionalHub`.

## Critérios E2E

1. Vínculo somente `training` não acessa avaliações; concessão explícita libera e revogação bloqueia.
2. Payload antropométrico extremo responde 400; resultado válido permanece entre 0 e 100.
3. Falha de escrita em create/correct/delete mantém GET e reinício no estado pré-operação.
4. Dois profissionais têm quotas independentes para o mesmo aluno; teto global continua efetivo.
5. PAR-Q positivo persiste flag/aviso e texto/ID estáveis para profissional e aluno.
6. Foto é legível apenas por aluno/criador autorizado e é removida após a última referência.
7. UI cria, corrige, lista, calcula deltas, apresenta erros/permissões e confirma exclusão.
8. OpenAPI, `website/api.html`, testes API/frontend, build e `git diff --check` ficam verdes.
