// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { DEF, useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { finishWorkoutNow } from './sheets.jsx'

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  sendMessage: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('./lib/api.js', () => ({
  api: (...args) => mocks.api(...args),
}))

vi.mock('./lib/communication-api.js', () => ({
  communicationApi: {
    sendMessage: (...args) => mocks.sendMessage(...args),
  },
}))

const clone = v => JSON.parse(JSON.stringify(v))
const S = () => useStore.getState().S
const mounted = []
let host

function renderTopSheet() {
  const sheet = useUI.getState().sheets.at(-1)
  host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
}

const settle = () => act(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
})

function install(entries) {
  const st = clone(DEF)
  st.routines = [{ id: 'r1', name: 'Treino A', ex: [{ id: '0025', sets: 1, reps: 5, weight: 60 }] }]
  st.active = {
    id: 'fin', d: '2026-11-08', start: Date.now() - 30 * 60000, routineIds: ['r1'], routineId: 'r1', name: 'Treino A', bw: null, cur: 0,
    entries,
  }
  useStore.setState({ S: st, user: { id: 'ath_1', name: 'Atleta' } })
}

const bench = { id: '0025', rid: 'r1', target: { sets: 1, reps: 5, weight: 60 }, sets: [{ w: 60, r: 5, done: true }] }

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  vi.clearAllMocks()
  useUI.setState({ sheets: [], timer: null, work: null, toast: mocks.toast })
  mocks.api.mockResolvedValue({
    links: [
      { id: 'lnk_1', status: 'active', scopes: ['training'], coach: { id: 'coach_1', name: 'Coach Ricardo' } },
    ],
  })
  mocks.sendMessage.mockResolvedValue({ message: { id: 'msg_1' } })
})

afterEach(() => {
  mounted.splice(0).forEach(r => act(() => r.unmount()))
  document.body.innerHTML = ''
})

describe('finish summary: effort rating and coach feedback', () => {
  it('exibe seletor de esforço percebido (PSE/RPE) e registra a nota no treino', async () => {
    install([clone(bench)])
    act(() => finishWorkoutNow())
    renderTopSheet()
    await settle()

    expect(host.querySelector('.fin-effort-section')).toBeTruthy()
    const buttons = [...host.querySelectorAll('.fin-effort-btn')]
    expect(buttons.length).toBe(10)

    // Click effort 8
    act(() => buttons[7].click())
    await settle()

    expect(buttons[7].classList.contains('on')).toBe(true)
    const savedWorkout = S().workouts.at(-1)
    expect(savedWorkout.effort).toBe(8)
  })

  it('permite enviar feedback para o treinador vinculado', async () => {
    install([clone(bench)])
    act(() => finishWorkoutNow())
    renderTopSheet()
    await settle()

    expect(host.querySelector('.fin-feedback-section')).toBeTruthy()
    const textarea = host.querySelector('.fin-feedback-section textarea')
    expect(textarea).toBeTruthy()

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Treino muito bom, consegui manter a carga.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()

    const sendBtn = [...host.querySelectorAll('.fin-feedback-section button')].find(b => b.textContent.includes('Send feedback') || b.textContent.includes('Enviar feedback'))
    expect(sendBtn).toBeTruthy()
    expect(sendBtn.disabled).toBe(false)

    await act(async () => {
      sendBtn.click()
    })
    await settle()

    expect(mocks.api).toHaveBeenCalledWith('/api/athlete/coaches')
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      side: 'athlete',
      counterpartId: 'coach_1',
      category: 'workout_feedback',
    }))
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/Feedback enviado ao treinador|Feedback sent to coach/))

    const savedWorkout = S().workouts.at(-1)
    expect(savedWorkout.coachFeedback).toBe('Treino muito bom, consegui manter a carga.')
  })

  it('lida com falha de requisição ou rede offline exibindo erro e permitindo tentar novamente', async () => {
    install([clone(bench)])
    mocks.sendMessage.mockRejectedValueOnce(new Error('Network offline'))
    act(() => finishWorkoutNow())
    renderTopSheet()
    await settle()

    const textarea = host.querySelector('.fin-feedback-section textarea')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Treino pesado, falha na conexão.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()

    const sendBtn = [...host.querySelectorAll('.fin-feedback-section button')].find(b =>
      b.textContent.includes('Send feedback') || b.textContent.includes('Enviar feedback')
    )

    await act(async () => {
      sendBtn.click()
    })
    await settle()

    // Does NOT mark feedbackSent
    expect(host.querySelector('.fin-feedback-section textarea')).toBeTruthy()
    // Displays clear error toast
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.stringMatching(/Não foi possível enviar a mensagem ao treinador|Could not send message to coach/)
    )
    // Local persistence of workout notes is intact
    const savedWorkout = S().workouts.at(-1)
    expect(savedWorkout.coachFeedback).toBe('Treino pesado, falha na conexão.')

    // Retry succeeds
    mocks.sendMessage.mockResolvedValueOnce({ message: { id: 'msg_2' } })
    await act(async () => {
      sendBtn.click()
    })
    await settle()

    expect(mocks.sendMessage).toHaveBeenCalledTimes(2)
    expect(host.querySelector('.fin-feedback-section textarea')).toBeFalsy()
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.stringMatching(/Feedback enviado ao treinador|Feedback sent to coach/)
    )
  })

  it('impede envio quando navigator.onLine for falso mantendo persistência local e exibindo erro', async () => {
    install([clone(bench)])
    const origOnLine = navigator.onLine
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    try {
      act(() => finishWorkoutNow())
      renderTopSheet()
      await settle()

      const textarea = host.querySelector('.fin-feedback-section textarea')
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Offline total no galpão.')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
        textarea.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await settle()

      const sendBtn = [...host.querySelectorAll('.fin-feedback-section button')].find(b =>
        b.textContent.includes('Send feedback') || b.textContent.includes('Enviar feedback')
      )

      await act(async () => {
        sendBtn.click()
      })
      await settle()

      expect(mocks.sendMessage).not.toHaveBeenCalled()
      expect(host.querySelector('.fin-feedback-section textarea')).toBeTruthy()
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.stringMatching(/Não foi possível enviar a mensagem ao treinador|Could not send message to coach/)
      )
      expect(S().workouts.at(-1).coachFeedback).toBe('Offline total no galpão.')
    } finally {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: origOnLine })
    }
  })
})
