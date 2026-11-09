import { act } from 'react'
import { expect, vi } from 'vitest'

const REACT_WARNING = /act\(|not wrapped in act|suspend(?:ed|ing)?|Suspense|unique ["']?key|Each child in a list/i

export function guardReactWarnings() {
  const consoleError = vi.spyOn(console, 'error')

  return () => {
    const messages = consoleError.mock.calls
      .map(args => args.map(String).join(' '))
      .join('\n')

    expect(messages, 'React emitted an act, Suspense, or key warning').not.toMatch(REACT_WARNING)
    consoleError.mockRestore()
  }
}

export async function waitForReact(assertion, { timeout = 1000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout
  let failure

  do {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, interval)) })
    try {
      return assertion()
    } catch (error) {
      failure = error
    }
  } while (Date.now() < deadline)

  throw failure
}
