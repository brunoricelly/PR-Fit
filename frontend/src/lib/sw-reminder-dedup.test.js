// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SW = readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8')

class MemoryCache {
  constructor() { this.rows = new Map() }
  key(value) { return typeof value === 'string' ? value : value.url }
  async match(key) { return this.rows.get(this.key(key)) }
  async put(key, response) { this.rows.set(this.key(key), response) }
  async delete(key) { return this.rows.delete(this.key(key)) }
  async keys() { return [...this.rows.keys()].map(url => ({ url })) }
}

function worker({ failStorage = false } = {}) {
  const handlers = {}
  const stores = new Map()
  const shown = []
  const open = async name => {
    if (failStorage && name.includes('reminder')) throw new Error('quota exceeded')
    if (!stores.has(name)) stores.set(name, new MemoryCache())
    return stores.get(name)
  }
  const context = {
    self: {
      addEventListener: (type, handler) => { handlers[type] = handler },
      skipWaiting() {},
      clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
      registration: {
        getNotifications: async () => [],
        showNotification: async (title, options) => { shown.push({ title, options }) },
      },
    },
    caches: { open, keys: async () => [...stores.keys()], delete: async name => stores.delete(name), match: async () => undefined },
    fetch: async () => new Response('', { status: 200 }),
    location: new URL('https://gym.example/sw.js'),
    URL, Response, Request, setTimeout, clearTimeout, console, Date,
  }
  vm.runInNewContext(SW, context)
  const push = data => new Promise((resolve, reject) => {
    handlers.push({
      data: { json: () => data, text: () => JSON.stringify(data) },
      waitUntil: promise => Promise.resolve(promise).then(resolve, reject),
    })
  })
  return { push, shown, stores }
}

const reminder = key => ({
  type: 'appointment_reminder', idempotencyKey: key,
  title: 'Upcoming appointment', body: 'Your scheduled appointment starts soon.', tag: key,
})

describe('appointment reminder service-worker deduplication', () => {
  it('reserves a persistent key before display and suppresses a duplicate transport delivery', async () => {
    const sw = worker()
    await Promise.all([sw.push(reminder('appointment-reminder:g1')), sw.push(reminder('appointment-reminder:g1'))])
    expect(sw.shown).toHaveLength(1)
    expect(sw.shown[0].options.renotify).toBe(false)
  })

  it('shows distinct generations and keeps the persistent store bounded', async () => {
    const sw = worker()
    await sw.push(reminder('appointment-reminder:g1'))
    await sw.push(reminder('appointment-reminder:g2'))
    expect(sw.shown).toHaveLength(2)
    for (let index = 3; index <= 620; index++) await sw.push(reminder(`appointment-reminder:g${index}`))
    const store = [...sw.stores.entries()].find(([name]) => name.includes('reminder'))?.[1]
    expect(store).toBeTruthy()
    expect((await store.keys()).length).toBeLessThanOrEqual(512)
  })

  it('fails conservatively when persistent reservation is unavailable', async () => {
    const sw = worker({ failStorage: true })
    await sw.push(reminder('appointment-reminder:g1'))
    expect(sw.shown).toHaveLength(0)
  })
})
