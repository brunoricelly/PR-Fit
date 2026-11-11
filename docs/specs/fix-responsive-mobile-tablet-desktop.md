# Spec: Responsividade Completa Mobile, Tablet e Desktop no PR Fit

## Contexto e Problema
A interface do PR Fit apresentava desproporções e estouro de elementos em telas de celular:
1. **RoleSwitcher (`.ds-role-switcher`)**: Ocupava ~399px fixos, extrapolando a largura de telas mobile de 320px–390px e quebrando o cabeçalho.
2. **Coach Tabbar (`.coach-tabbar` / `#tabbar`)**: As 7 abas do treinador em telas < 420px sofriam sobreposição e overflow horizontal (`scrollWidth > clientWidth`).
3. **Container Principal (`#app` e Tablet)**: Travado em 560px em resoluções de tablet (768px-999px), criando barras pretas desproporcionais e subaproveitamento do espaço.
4. **Dashboard Grids**: Colunas de ações rápidas e cartões de prioridade comprimidos no mobile.

## Modificações Requeridas
1. `frontend/src/components/RoleSwitcher.css`:
   - Em telas `<= 480px`: largura de 100%, `.ds-role-switcher` com `width: 100%`, botões com `flex: 1`, padding `6px 8px`, fonte `13px`, `min-width: 0`, e texto sem quebra descontrolada.
2. `frontend/src/index.css`:
   - Breakpoint Tablet (`@media (min-width: 600px) and (max-width: 999px)`): expandir `#app` para `max-width: 760px`.
   - Regra `#tabbar` e `.coach-tabbar` em telas `<= 440px`:
     - `#tabbar button` com `min-width: 0`, `padding: 4px 1px`, fonte `9px`, ícones `22px`.
     - Suporte a rolagem horizontal suave com `overflow-x: auto; scrollbar-width: none;` caso a tela seja ultra-estreita (320px).
3. `frontend/src/views/dashboard/DashboardHome.css`:
   - Garantir que em telas `< 600px` as prioridades fiquem em coluna única e os botões tenham área de toque confortável (mínimo 44px).
   - Otimizar espaçamentos em tablets.

## Critérios de Aceitação
- Testes automatizados passando (`npm test`).
- Build do Vite sem erros (`npm run build`).
- Nenhuma barra de rolagem horizontal no documento (`document.documentElement.scrollWidth <= window.innerWidth`) em 320px, 375px, 390px, 768px e 1280px.
