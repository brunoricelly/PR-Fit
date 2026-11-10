# Spec: Recurso 5 — Exportação de Relatório de Evolução em PDF Personalizado

## Objetivo
Permitir que o Treinador ou o Aluno exportem um relatório visual completo de evolução corporal em PDF diagramado de alta qualidade para impressão, download ou compartilhamento no WhatsApp/Instagram.

## Funcionalidades
1. Conteúdo do Relatório:
   - Capa com identidade visual oficial do PR Fit e identificação do treinador/aluno.
   - Resumo executivo do período (7, 30, 90 dias ou customizado).
   - Quadro de Métricas: Peso corporal, % de Gordura (Pollock/Faulkner), Massa Magra (kg), IMC, RCQ.
   - Histórico de Perimetria / Circunferências (tórax, cintura, quadril, braços, pernas).
   - Galeria Comparativa de Fotos Posturais (Antes x Depois em ângulos alinhados).
   - Metas alcançadas e assiduidade de treinos/hábitos no período.
2. Botão de Exportação:
   - Integrado nos componentes de progresso (`ProgressAnalytics.jsx` / `ProfessionalHub.jsx` / `Stats.jsx`).
   - Opção de "Exportar Relatório PDF" com estilo print CSS / canvas / jsPDF / print nativo otimizado.
3. Microcópia em PT-BR.
4. Testes unitários cobrindo o fluxo de exportação.
