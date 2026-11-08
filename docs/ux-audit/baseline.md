# Baseline mensurável — Etapa 0

## Identificação e reprodução

- Data da medição: **2026-11-08 (UTC)**.
- Branch: `feat/ux-modernization`.
- Seed verificado antes das mudanças: `fe464e0df42ea6c7bd720c7ab000209a8cd54a67`.
- Ambiente: Node `v22.18.0`, npm `10.9.3`, Vite `8.3.5`, Linux; dependências instaladas com `npm ci` em `frontend` e `api`.
- O plano mestre foi copiado integralmente para `docs/specs/ux-modernization.md` (`cmp` deve retornar zero).

Comandos do harness:

```bash
npm run audit:ux --prefix frontend
node frontend/scripts/ux-audit.mjs --json /tmp/ux-audit-report.json
npm exec --prefix frontend vitest -- run scripts/ux-audit.test.mjs
```

`audit:ux` lê `App.jsx`, imports lazy/eager e referências de navegação; verifica que a tabela de rotas e a baseline de inglês continuam sincronizadas. O allowlist versionado em `frontend/scripts/ux-audit-allowlist.json` contém oito valores técnicos/brand/diagnóstico deliberado e dois padrões técnicos. Dívida existente não entra no allowlist: fica congelada por fingerprint em `frontend/scripts/ux-audit-language-baseline.json`, de modo que texto novo falha o check.

## Rotas e código

| Medida | Resultado |
| --- | ---: |
| Declarações `<Route>` | 35 |
| Views críticas auditadas estaticamente | 8 |
| Rotas eager de tela principal | Home, Plan, Workout |
| Demais views de rota | lazy, por `lazyView` |
| Fallback lazy | `null` |
| Arquivos de teste frontend descobertos | 665 |

O inventário gerado e a classificação de proteção estão em `route-inventory.md`.

## Build e chunks

Comando:

```bash
npm run build --prefix frontend
node frontend/scripts/bundle-size.mjs --out /tmp/ux-bundle-size.json
```

Resultado real:

- Build verde: **492 módulos transformados em 7,07 s** na validação final.
- `dist`: **172** artefatos JS/CSS/HTML (**162 JS**, **9 CSS**, **1 HTML**), cerca de **29 MB** em disco.
- Medidor existente: **28.919,0 kB raw / 5.834,9 kB gzip**; **127 chaves estáveis**. A diferença 172→127 ocorre porque o script normaliza hashes e sobrescreve nomes homônimos no detalhe, embora preserve o total acumulado.
- Shell principal `index` JS: **590,35 kB raw / 186,03 kB gzip**.
- CSS principal: **174,37 kB raw / 33,76 kB gzip**.
- Maiores arquivos reportados pelo Vite: `en` **1.794,89 kB raw / 312,80 kB gzip**, `hi` **1.585,00 / 122,05 kB**, `exercises` **1.221,98 / 156,97 kB**, `ru` **1.056,93 / 106,41 kB**.

Warnings preservados e classificados:

1. chunks acima de 1.500 kB após minificação;
2. import dinâmico de `@capacitor/core` ineficaz porque o módulo também entra estaticamente;
3. import dinâmico de `src/lib/scan-web.js` ineficaz porque `CameraScan.jsx` também o importa estaticamente;
4. diagnóstico `PLUGIN_TIMINGS`: callbacks JavaScript consumiram 1,2 s e o transform CSS foi listado para profiling.

Não há orçamento de performance aprovado nesta etapa e nenhuma afirmação de Core Web Vitals/Lighthouse foi feita.

## Testes

| Escopo | Comando | Resultado |
| --- | --- | --- |
| Harness UX focado | `cd frontend && npx vitest run scripts/ux-audit.test.mjs` | **1 arquivo, 6 testes, 6 pass, 0 fail** |
| Frontend completo | `cd frontend && npx vitest run` | **665 arquivos, 8.032 testes, 8.032 pass, 0 fail, 451,71 s** |
| API focada | `cd api && node --test test/routes.test.js test/openapi-routes.test.js test/b2b2c-policy.test.js test/scheduling-contract.test.js` | **4 arquivos, 37 testes, 37 pass, 0 fail, 9,17 s** |
| Locales | `node frontend/scripts/check-locales.mjs` | **19 locales × 3.615 chaves, sincronizados** |
| Chaves i18n usadas | `node frontend/scripts/check-source-strings.mjs` | **2.961 strings usadas; 0 ausente de todos os packs** |

A suíte frontend emitiu **139 blocos de stderr** sem falhar: **288** mensagens “not wrapped in act(...)”, **2** linhas do diagnóstico de `<button>` aninhado em Settings/Equipment e **1** warning de chave duplicada `g_1` em ProgressAnalytics. Eles permanecem documentados; esta etapa não os silencia.

## Idiomas

- O sistema de i18n tem inglês como source language e **19 packs de locale** versionados.
- O checker de chaves está verde, mas isso não detecta JSX/atributos não passados por `t()`/`professionalText()`.
- O novo scanner encontrou **78** ocorrências óbvias visíveis em inglês: **46 em `Admin.jsx` e 32 em `AdminCoach.jsx`**.
- O allowlist aceita placeholders/brand (`HH:MM`, URL, código de grupo, openGym, PR Fit), três rótulos do diagnóstico deliberadamente não traduzido de animation packs e padrões técnicos de método/API ou token curto em caixa alta.
- A auditoria é conservadora: detecta texto JSX simples na mesma linha e atributos `aria-label`, `title`, `placeholder`, `alt`; não promete extração semântica completa sem parser JSX.

## Acessibilidade estrutural

Resultado estático do harness nas oito views críticas:

| View | h1 | h2 | h3 | h4 | `main` | `nav` | Observação |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Home | 1 | 0 | 0 | 0 | 0 | 0 | sem landmark de conteúdo |
| Plan | 1 | 0 | 0 | 3 | 0 | 0 | salto h1→h4 |
| Workout | 1 | 1 | 1 | 1 | 0 | 0 | sem landmark de conteúdo |
| Stats | 1 | 9 | 0 | 5 | 0 | 1 | salto h2→h4 em seções |
| ProfessionalHub | 1 | 10 | 3 | 1 | 1 | 1 | estrutura nova mais semântica |
| SchedulingView | 1 | 6 | 5 | 0 | 1 | 1 | estrutura nova mais semântica |
| CommunityHub | 0 | 0 | 0 | 0 | 0 | 1 | headings ficam nas views filhas; shell isolado não nomeia a página |
| Admin | 1 | 5 | 3 | 1 | 0 | 0 | sem landmarks e inglês visível |

Alvos de toque — evidência CSS, não medição de layout:

- `.gc-tab` declara `min-height: 42px`, abaixo do alvo de 44 px.
- `.gc-filter-btn` usa apenas `padding: 6px 12px`, sem mínimo de 44 px.
- `.btn.sm` usa `padding: 8px 14px`, também sem mínimo explícito.
- `.iconbtn` pinta 36×36, mas amplia a hit area com pseudo-elemento de 6 px, chegando teoricamente a 48×48 quando não há clipping/sobreposição.

O harness inclui probes reproduzíveis para `getBoundingClientRect`, overflow, saltos de heading, landmarks e console. Em `happy-dom`, eles são validados com fixtures; não são usados para afirmar conformidade das telas reais.

## Responsividade, overflow, console e screenshots

O ambiente não tem `chromium`, `chromium-browser`, `google-chrome`, `firefox`, Playwright ou Cypress. Portanto:

- não foi possível executar layout real em 1440/768/375/412;
- não foi possível medir overflow horizontal computado, foco/teclado, touch targets reais ou console de rotas reais;
- não foi possível capturar a matriz de screenshots exigida pelo plano mestre.

Há cinco screenshots versionados (`home`, `plan`, `workout`, `stats`, `library`), todos **1170×2532**, do commit `922b586a6ee89c2e166baef1ef3a50e062b77374` de **2026-10-26**, descritos como v1.4.3. Eles não cobrem o seed atual, desktop/tablet, papéis profissionais, dual-role ou Admin e, por isso, não são aceitos como baseline desta etapa.

A suíte de testes serve como evidência parcial de console: além dos warnings React acima, não houve falha do harness. Isso não equivale a console limpo em browser.

## Estados e offline

- Views profissionais recentes implementam loading, empty, error e retry de forma explícita na maioria dos painéis.
- Views pessoais legadas são local-first e normalmente não têm loading/error de fetch; problemas de sincronização são centralizados em `SyncBanner`/indicador na Home.
- Não foi encontrado um estado offline específico nas views profissionais; indisponibilidade de rede tende a aparecer como erro genérico com retry.
- Rotas condicionais por módulo e paths inválidos caem no redirect global para Home, sem distinguir indisponível, sem permissão e 404.

## Limites desta baseline

Esta baseline mede código, build, testes, i18n e semântica estática. Ela **não** certifica WCAG 2.2 AA, contraste, performance de usuário, responsividade ou ausência de erro de console. O gap browser está marcado como P1 de gate em `backlog.md` e precisa ser fechado em ambiente com navegador antes de alterações amplas de navegação.
