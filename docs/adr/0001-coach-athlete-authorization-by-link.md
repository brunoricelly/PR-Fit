# ADR 0001: autorização coach-atleta por vínculo explícito

**Status:** aceita
**Data:** 2026-11-06

## Contexto

O PR Fit armazena contas em `db.json` e um documento de treino por usuário. A autorização atual é
proprietária: cada sessão acessa apenas o próprio `state-<uid>.json`; administradores possuem rotas
operacionais separadas. A evolução B2B2C exige que profissionais atendam vários atletas e que um
atleta possa ter vários profissionais, com escopos independentes.

Conceder a todo coach acesso a todos os usuários, inferir acesso pelo papel ou criar uma instância
por profissional produziria isolamento insuficiente, dificultaria múltiplos profissionais por
atleta e aumentaria o risco de IDOR.

## Decisão

1. Papel de produto (`athlete`/`coach`) e papel administrativo permanecem independentes.
2. Toda autorização delegada depende de uma entidade de vínculo coach-atleta, com escopos e estado.
3. Apenas vínculo `active` concede capabilities; `pending`, `suspended` e `ended` não concedem.
4. O backend deriva o ator da sessão, carrega o vínculo e aplica uma política central. Identificadores
   enviados pelo cliente nunca definem o ator.
5. Admin/owner não recebe bypass automático para dados do atleta.
6. Convites usam token aleatório opaco, hash persistido, expiração, aceite explícito e idempotência.
7. O schema de `db.json` evolui de forma aditiva e versionada. Contas sem perfil são lidas como
   atletas, e arquivos de treino existentes não são migrados ou reescritos.
8. Metadados de vínculo são server-authoritative e ficam fora do merge offline do documento de
   treino.
9. Rotas futuras de prescrição não abrirão `GET/PUT /api/data` para ids arbitrários; usarão recursos
   delegados, revisão e auditoria próprias.

## Consequências positivas

- isolamento segue consentimento e finalidade, não topologia de deploy;
- múltiplos coaches e múltiplos escopos são representáveis;
- suspensão e encerramento revogam acesso sem apagar dados do atleta;
- a política pode ser testada contra IDOR em um único ponto;
- o modelo é compatível com a persistência simples atual e com merges futuros do upstream.

## Consequências negativas

- toda nova rota delegada precisa declarar capability e chamar a política;
- listagens e auditoria exigem projeções adicionais sobre `db.json`;
- operações de vínculo precisam de conexão, pois não podem usar o merge offline pessoal;
- dados clínicos futuros exigirão retenção, consentimento e controles adicionais.

## Alternativas rejeitadas

### Acesso global por papel `coach`

Rejeitado porque permite enumeração e acesso transversal a atletas não vinculados.

### Um tenant/instância por profissional

Rejeitado porque impede naturalmente um atleta com vários profissionais, duplica contas e desloca
o problema de consentimento para sincronização entre instâncias.

### Lista de atletas dentro do objeto do coach

Rejeitada porque duplica estado, dificulta consultas pelo atleta, transições auditáveis e
integridade bidirecional.

### Reutilizar convites administrativos

Rejeitado porque esses códigos autorizam cadastro na instância e possuem semântica, exposição e
ciclo de vida diferentes de consentimento profissional.
