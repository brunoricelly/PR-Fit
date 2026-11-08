# PR Fit Design System

## Escopo

A fundação visual da Etapa 1 vive em `frontend/src/design-system.css` e nos componentes exportados por `frontend/src/components/design-system.jsx`. As adoções explícitas atuais estão em `/coach/groups` e nos dashboards por papel de `/home`; as demais telas continuam usando os estilos legados até uma migração explícita.

## Tokens canônicos

Novos componentes devem consumir somente tokens semânticos `--ds-*`:

- superfícies: `--ds-surface-page|base|subtle|raised|overlay`;
- texto e bordas: `--ds-text-primary|secondary|muted`, `--ds-border-subtle|strong`;
- marca e estados: `--ds-color-brand`, `--ds-state-info|success|warning|danger` e respectivas superfícies;
- espaçamento: `--ds-space-0|1|2|3|4|5|6|8|10|12|16`;
- tipografia: `--ds-font-*`, `--ds-line-height-*` e `--ds-font-weight-*`;
- geometria: `--ds-radius-*`, `--ds-shadow-*`;
- movimento: `--ds-motion-duration-*`, `--ds-motion-ease-standard`;
- camadas: `--ds-z-*`;
- referências responsivas: `--ds-breakpoint-sm|md|lg|xl`.

Os temas claro e escuro redefinem apenas valores semânticos. O teste `frontend/src/design-system-css.test.js` lê o CSS canônico e reproduz o cálculo WCAG dos pares principais.

## Componentes

Importe da fachada única:

```jsx
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Surface,
  Switch,
  Tabs,
  Textarea,
  Toast,
  Tooltip,
} from '../components/design-system.jsx'
```

### Regras de uso

- `Button`: use `primary` para uma única ação principal por contexto; `secondary` para alternativas; `ghost` para ações discretas; `destructive` para consequências destrutivas. `loading` desabilita a ação e publica `aria-busy`.
- `IconButton`: sempre informe `label`; o alvo mínimo é 44×44 px.
- `Field`: concentra label, ajuda, erro, `aria-describedby`, `aria-invalid` e obrigatoriedade. Não monte mensagens de erro soltas.
- `Card`: use somente quando houver agrupamento contextual real. Para agrupamento neutro sem elevação, prefira `Surface`.
- `Modal` e `Drawer`: já incluem foco inicial, focus trap, Escape, restauração de foco, bloqueio de scroll e suporte a sobreposição de diálogos.
- `Toast`: permanece conectado ao store global existente; use a ação de toast do `useUI` em vez de montar instâncias locais.
- `EmptyState` e `ErrorState`: forneça CTA que execute uma ação real. Mensagens sem ação são aceitáveis apenas quando não existe recuperação local.
- `Tabs`: use para alternar painéis no mesmo contexto, nunca como substituto de rotas. Setas, Home e End são suportados.
- `Tooltip`: conteúdo complementar curto; não esconda informação necessária para concluir uma tarefa.

## Migração incremental

1. Adicione `ds-scope` à raiz da superfície migrada.
2. Troque cores e medidas locais por `--ds-*`; não altere aliases globais para “forçar” a migração.
3. Substitua controles isolados pelos exports de `design-system.jsx`.
4. Cubra loading, vazio, erro e sucesso antes de remover estilos legados.
5. Rode testes focados, `audit:ux`, build e inspeção mobile antes de ampliar o escopo.

## Aliases legados e deprecações

Os aliases `--bg`, `--surface*`, `--label*`, `--sep`, `--acc*`, `--r-*`, `--fast`, `--med` e `--ease` continuam válidos para telas antigas. Dentro de `.ds-scope`, eles apontam temporariamente para os tokens canônicos para manter componentes ainda não migrados visualmente coerentes.

Estão depreciados para código novo:

- imports diretos de `Button`, campos e `Switch` a partir de `components/ui.jsx`;
- classes de apresentação `card`, `gc-alert`, `gc-badge` e skeletons locais em superfícies migradas;
- `AccessibleModal` como API nova. Ele permanece como adaptador compatível sobre `Modal` enquanto consumidores legados são migrados;
- cores, sombras, raios, durações e espaçamentos literais fora de casos gráficos específicos.

Não remova aliases ou adaptadores até que uma busca de uso e os shards afetados comprovem que nenhum consumidor legado depende deles.

## Validação

- componentes, estados e teclado: `npm test --prefix frontend -- --run src/components/design-system.test.jsx`;
- tokens, contraste, reduced motion e estrutura responsiva: `npm test --prefix frontend -- --run src/design-system-css.test.js`;
- superfície piloto: `npm test --prefix frontend -- --run src/views/coach/CoachViews.test.jsx`;
- scanner de idioma: `npm run audit:ux --prefix frontend`.
