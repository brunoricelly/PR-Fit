import { beforeEach, describe, expect, it, vi } from 'vitest'
import { communicationApi } from './communication-api.js'

const mocks = vi.hoisted(() => ({ api: vi.fn() }))

vi.mock('./api.js', () => ({ api: (...args) => mocks.api(...args) }))

beforeEach(() => vi.clearAllMocks())

describe('communication-api cancellation', () => {
  it('forwards the AbortSignal used by dashboard reads', async () => {
    const controller = new AbortController()
    mocks.api.mockResolvedValue({ conversations: [] })

    await communicationApi.inbox({ limit: 20 }, { signal: controller.signal })
    await communicationApi.athleteHabits('America/Sao_Paulo', { signal: controller.signal })
    await communicationApi.summary({
      side: 'coach', athleteId: 'athlete_1', linkId: 'link_1', period: 7, timeZone: 'UTC',
    }, { signal: controller.signal })

    expect(mocks.api).toHaveBeenNthCalledWith(1, '/api/messages/inbox?limit=20', { signal: controller.signal })
    expect(mocks.api).toHaveBeenNthCalledWith(2, '/api/athlete/habits?timezone=America%2FSao_Paulo', { signal: controller.signal })
    expect(mocks.api).toHaveBeenNthCalledWith(3, '/api/coach/athletes/athlete_1/habits-summary?linkId=link_1&period=7&timezone=UTC', { signal: controller.signal })
  })
})
