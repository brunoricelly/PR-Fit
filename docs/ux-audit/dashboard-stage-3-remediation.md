# Etapa 3 — decisões de isolamento dos dashboards

- **Hábitos no modo Atleta de conta dual-role:** o contrato `GET /api/athlete/habits` exige perfil não profissional. O dashboard não chama esse endpoint quando `profile.kind === "coach"`; o módulo aparece como indisponível, sem alterar autorização, tenant scope ou anti-IDOR.
- **Inbox no modo Atleta de conta dual-role:** `GET /api/messages/inbox` agrega todos os vínculos da identidade e não informa o lado do papel. O dashboard não apresenta contagem atribuída ao papel Atleta nesse contexto.
- **Inbox do Coach:** conversas só entram em métricas do Coach quando o `linkId` também veio de `GET /api/coach/athletes`, que é o portfólio contratualmente limitado ao profissional autenticado. Se vínculos ou inbox falham, a contagem do papel fica indisponível.
- **Resumos do Coach:** todos os vínculos ativos com escopo de treino retornados pelo contrato atual, que não é paginado, são processados com concorrência máxima de três. Falhas individuais ficam registradas na interface; nenhum vínculo retornado é silenciosamente descartado.
