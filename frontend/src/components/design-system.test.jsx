// @vitest-environment happy-dom
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Modal,
  Select,
  Skeleton,
  Surface,
  Switch,
  Tabs,
  Textarea,
  Tooltip,
} from './design-system.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host
let root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.style.overflow = ''
  document.body.style.paddingRight = ''
})

const render = component => act(() => root.render(<div className="ds-scope">{component}</div>))

describe('PR Fit design-system controls', () => {
  it('exposes button variants, loading state and accessible icon labels', () => {
    render(<>
      <Button variant="primary">Salvar</Button>
      <Button variant="secondary">Cancelar</Button>
      <Button variant="ghost">Ajuda</Button>
      <Button variant="destructive">Excluir</Button>
      <Button loading loadingLabel="Salvando">Salvar</Button>
      <IconButton icon="xmark" label="Fechar" />
    </>)

    const buttons = [...host.querySelectorAll('button')]
    expect(buttons.slice(0, 4).map(button => button.className)).toEqual([
      expect.stringContaining('primary'),
      expect.stringContaining('secondary'),
      expect.stringContaining('ghost'),
      expect.stringContaining('destructive'),
    ])
    expect(buttons[4].disabled).toBe(true)
    expect(buttons[4].getAttribute('aria-busy')).toBe('true')
    expect(buttons[5].getAttribute('aria-label')).toBe('Fechar')
  })

  it('connects field help and errors to form controls', () => {
    render(<>
      <Field label="Nome" help="Como será exibido" error="Campo obrigatório" required><Input name="name" /></Field>
      <Field label="Descrição"><Textarea name="description" /></Field>
      <Field label="Categoria"><Select name="category"><option>Força</option></Select></Field>
      <Checkbox label="Aceito" />
      <Switch aria-label="Grupo privado" checked={false} onChange={() => {}} />
    </>)

    const input = host.querySelector('input[name="name"]')
    const label = host.querySelector(`label[for="${input.id}"]`)
    expect(label?.textContent).toContain('Nome')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toContain(`${input.id}-error`)
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Campo obrigatório')
    expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
  })

  it('renders reusable surfaces, states and feedback semantics', () => {
    render(<>
      <Surface>Superfície</Surface>
      <Card>Card</Card>
      <Alert tone="error" title="Falha">Tente novamente.</Alert>
      <Badge tone="success">Ativo</Badge>
      <Skeleton label="Carregando grupos" height="2rem" />
      <EmptyState title="Sem grupos" text="Crie o primeiro." action={<Button>Criar</Button>} />
      <ErrorState title="Falha ao carregar" text="Verifique sua conexão." action={<Button>Tentar novamente</Button>} />
    </>)

    expect(host.querySelector('.ds-surface')).toBeTruthy()
    expect(host.querySelector('.ds-card')).toBeTruthy()
    expect(host.querySelector('.ds-alert[role="alert"]')).toBeTruthy()
    expect(host.querySelector('.ds-skeleton[role="status"]')?.getAttribute('aria-label')).toBe('Carregando grupos')
    expect(host.textContent).toContain('Sem grupos')
    expect(host.textContent).toContain('Falha ao carregar')
  })
})

describe('PR Fit design-system keyboard behavior', () => {
  it('traps focus, closes on Escape, locks scroll and restores focus', () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return <>
        <button type="button" id="opener" onClick={() => setOpen(true)}>Abrir</button>
        {open && <Modal id="test-modal" title="Editar grupo" onClose={() => setOpen(false)}>
          <Input name="groupName" />
          <Button id="last-action">Salvar</Button>
        </Modal>}
      </>
    }

    render(<Harness />)
    const opener = host.querySelector('#opener')
    opener.focus()
    act(() => opener.click())

    const dialog = host.querySelector('[role="dialog"]')
    const closeButton = dialog.querySelector('[aria-label="Fechar"]')
    const lastAction = dialog.querySelector('#last-action')
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.activeElement).toBe(closeButton)

    act(() => {
      closeButton.focus()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    })
    expect(document.activeElement).toBe(lastAction)

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.style.overflow).toBe('')
    expect(document.activeElement).toBe(opener)
  })

  it('moves accessible tabs with arrow, Home and End keys', () => {
    function Harness() {
      const [value, setValue] = useState('groups')
      return <Tabs
        ariaLabel="Comunidade"
        value={value}
        onChange={setValue}
        tabs={[
          { value: 'groups', label: 'Grupos', content: 'Painel de grupos' },
          { value: 'challenges', label: 'Desafios', content: 'Painel de desafios' },
          { value: 'programs', label: 'Programas', content: 'Painel de programas' },
        ]}
      />
    }

    render(<Harness />)
    const first = host.querySelector('[role="tab"]')
    act(() => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Desafios')
    act(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Programas')
    expect(host.querySelector('[role="tabpanel"]')?.textContent).toBe('Painel de programas')
  })

  it('shows tooltip content for keyboard focus and removes it on blur', () => {
    render(<Tooltip content="Código usado para entrar no grupo"><button type="button">Ajuda</button></Tooltip>)
    const trigger = host.querySelector('button')
    act(() => trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    expect(host.querySelector('[role="tooltip"]')?.textContent).toContain('Código usado')
    expect(trigger.getAttribute('aria-describedby')).toBe(host.querySelector('[role="tooltip"]')?.id)
    act(() => trigger.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(host.querySelector('[role="tooltip"]')).toBeNull()
  })
})
