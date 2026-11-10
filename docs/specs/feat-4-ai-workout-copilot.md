# Spec: Fase 4 — Prescrição Expressa com IA (Copiloto do Treinador)

## Objetivo
Permitir que o Treinador ou Nutricionista clique no botão "Sugerir com IA" ou "Prescrever com IA" ao criar/editar uma rotina no PR Fit.

## Funcionalidades
1. Modal amigável com seleção de:
   - Objetivo: Hipertrofia, Emagrecimento/Definição, Força, Resistência.
   - Frequência / Divisão: ABC (Push/Pull/Legs), AB (Superior/Inferior), Full Body, 4 dias, 5 dias.
   - Nível do Aluno: Iniciante, Intermediário, Avançado.
   - Foco Muscular Prioritário: Glúteos/Pernas, Peitoral/Ombro, Costas/Bíceps, Equilibrado.
   - Restrições / Dores (opcional): Lombar, Joelho, Ombro.
2. Mecanismo de Geração:
   - Gerador inteligente baseado no catálogo de 5.600 exercícios do PR Fit.
   - Distribuição de séries, repetições alvo e tempo de descanso apropriado ao objetivo.
   - Respeito às restrições selecionadas (ex: se marcou dor no joelho, evita agachamento profundo e prioriza exercícios seguros com isolamento).
3. Adoção no Treino:
   - O treinador visualiza a sugestão em tela.
   - Com 1 clique em "Aplicar este treino", a rotina é montada automaticamente na tela do profissional para revisão final antes de salvar.

## Critérios de Aceitação
- Testes unitários/componentes passando com sucesso.
- Microcópia 100% em PT-BR.
- Acessibilidade e navegação por teclado preservadas.
