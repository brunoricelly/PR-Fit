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
  LiveFeedback,
  Modal,
  Select,
  Skeleton,
  Spinner,
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

    const dialog = document.querySelector('[role="dialog"]')
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
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.style.overflow).toBe('')
    expect(document.activeElement).toBe(opener)
  })

  it('portals modal content to #modal-root when present, otherwise to document.body', () => {
    const modalRoot = document.createElement('div')
    modalRoot.id = 'modal-root'
    document.body.appendChild(modalRoot)
    try {
      render(<Modal id="portal-modal" title="Portal test"><div>Conteúdo</div></Modal>)
      expect(modalRoot.querySelector('[role="dialog"]')).toBeTruthy()
    } finally {
      modalRoot.remove()
    }
  })

  it('skips hidden elements when trapping focus', () => {
    render(
      <Modal id="hidden-nodes-modal" title="Teste Ocultos">
        <button type="button" style={{ display: 'none' }} id="btn-display-none">Invisível</button>
        <button type="button" aria-hidden="true" id="btn-aria-hidden">Oculto</button>
        <button type="button" id="visible-btn-1">Visível 1</button>
        <button type="button" id="visible-btn-2">Visível 2</button>
        <button type="button" hidden id="btn-hidden">Hidden attr</button>
        <input type="hidden" name="hidden-input" id="inp-hidden" />
      </Modal>
    )
    const dialog = document.querySelector('[role="dialog"]')
    const closeBtn = dialog.querySelector('[aria-label="Fechar"]')
    const btn1 = dialog.querySelector('#visible-btn-1')
    const btn2 = dialog.querySelector('#visible-btn-2')

    act(() => {
      closeBtn.focus()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    })
    expect(document.activeElement).toBe(btn2)

    act(() => {
      btn2.focus()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    expect(document.activeElement).toBe(closeBtn)
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

  it('renders LiveFeedback with accessible aria-live polite region and status/alert roles', () => {
    const { rerender } = root
    render(<LiveFeedback />)
    const emptyFeedback = host.querySelector('.ds-live-feedback')
    expect(emptyFeedback?.getAttribute('aria-live')).toBe('polite')
    expect(emptyFeedback?.textContent).toBe('')

    render(<LiveFeedback success="Operação concluída com sucesso" />)
    expect(host.querySelector('.ds-live-feedback.is-success')).toBeTruthy()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Operação concluída com sucesso')

    render(<LiveFeedback error="Falha ao salvar dados" />)
    expect(host.querySelector('.ds-live-feedback.is-error')).toBeTruthy()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Falha ao salvar dados')
  })

  it('renders background Spinner with accessible status role and non-blocking structure', () => {
    render(<Spinner label="Sincronizando em segundo plano" />)
    const spinner = host.querySelector('.ds-spinner[role="status"]')
    expect(spinner).toBeTruthy()
    expect(spinner?.getAttribute('aria-label')).toBe('Sincronizando em segundo plano')
    expect(spinner?.querySelector('.ds-spinner-inner')).toBeTruthy()
    expect(spinner?.querySelector('.sr-only')?.textContent).toBe('Sincronizando em segundo plano')
  })

  it('supports 1-tap retry in ErrorState and Alert', () => {
    const onRetryError = vi.fn()
    const onRetryAlert = vi.fn()

    render(<>
      <ErrorState title="Erro de rede" text="Não foi possível conectar." onRetry={onRetryError} retryLabel="Tentar de novo" />
      <Alert tone="error" title="Aviso" onRetry={onRetryAlert} retryLabel="Recarregar">Falha momentânea.</Alert>
    </>)

    const errorRetryBtn = host.querySelector('.ds-error-retry')
    expect(errorRetryBtn?.textContent).toContain('Tentar de novo')
    act(() => errorRetryBtn.click())
    expect(onRetryError).toHaveBeenCalledTimes(1)

    const alertRetryBtn = host.querySelector('.ds-alert-retry')
    expect(alertRetryBtn?.textContent).toContain('Recarregar')
    act(() => alertRetryBtn.click())
    expect(onRetryAlert).toHaveBeenCalledTimes(1)
  })
})
